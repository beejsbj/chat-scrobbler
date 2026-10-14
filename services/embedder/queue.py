"""Bounded admission and query-first waiting, around one engine mutex."""
import threading
import time

from .errors import RequestError


class EngineQueue:
    def __init__(self, lock, size, timeout):
        self.lock, self.timeout = lock, timeout
        self.slots = threading.BoundedSemaphore(size + 1)
        self.condition = threading.Condition()
        self.waiters = []
        self.sequence = 0

    @property
    def queued(self):
        with self.condition:
            return len(self.waiters)

    def acquire(self, query):
        if not self.slots.acquire(blocking=False):
            raise RequestError('embedding queue is full', 429, 'queue_full')
        deadline = time.monotonic() + self.timeout
        acquired = False
        with self.condition:
            ticket = (0 if query else 1, self.sequence)
            self.sequence += 1
            self.waiters.append(ticket)
            self.waiters.sort()
            try:
                while True:
                    if self.waiters[0] == ticket and self.lock.acquire(blocking=False):
                        acquired = True
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RequestError('embedding queue wait expired', 503, 'queue_timeout')
                    self.condition.wait(remaining)
            finally:
                self.waiters.remove(ticket)
                self.condition.notify_all()
                if not acquired:
                    self.slots.release()

    def notify(self):
        with self.condition:
            self.condition.notify_all()

    def release(self):
        self.lock.release()
        self.slots.release()
        self.notify()

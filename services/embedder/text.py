import math
import re
from .errors import RequestError

QUERY_PREFIX = 'task: search result | query: '


def byte_length(text):
    try:
        return len(text.encode('utf-8'))
    except UnicodeError as exc:
        raise RequestError('text must be valid Unicode') from exc


def text_chunks(text, role, title, input_format, limit):
    """Keep exact content, including whitespace, with a prefix on every chunk."""
    if input_format == 'prefixed':
        if role == 'query' and text.startswith(QUERY_PREFIX):
            prefix, body = QUERY_PREFIX, text[len(QUERY_PREFIX):]
        elif role == 'document' and title is not None:
            prefix = f'title: {title} | text: '
            if not text.startswith(prefix):
                raise RequestError('prefixed document must match the supplied title')
            body = text[len(prefix):]
        elif role == 'document' and text.startswith('title: ') and ' | text: ' in text:
            heading, body = text.split(' | text: ', 1)
            prefix = heading + ' | text: '
        else:
            raise RequestError('prefixed input must match its query or document role')
    else:
        prefix = QUERY_PREFIX if role == 'query' else f'title: {title if title is not None else "none"} | text: '
        body = text
    room = limit - byte_length(prefix)
    if room < 32 or not body.strip():
        raise RequestError('empty content or prefix exceeds chunk budget')
    chunks = []
    while body:
        # Decode only a complete UTF-8 prefix. This also bounds unbroken/CJK text.
        head = body.encode('utf-8')[:room].decode('utf-8', errors='ignore')
        end = len(head)
        if end < len(body):
            # Prefer substantial paragraphs, then sentences, then words.
            for pattern in (r'\n\s*\n', r'[.!?]\s+', r'\s+'):
                boundaries = [m.end() for m in re.finditer(pattern, head) if m.end() >= end // 2]
                if boundaries:
                    end = boundaries[-1]
                    break
        chunks.append(prefix + body[:end])
        body = body[end:]
    return chunks


def normalize(vector):
    vector = [float(x) for x in vector]
    if not vector or not all(math.isfinite(x) for x in vector):
        raise RequestError('engine returned a nonfinite embedding', 500, 'engine_error')
    norm = math.hypot(*vector)
    if not math.isfinite(norm) or norm == 0:
        raise RequestError('engine returned a zero or invalid embedding', 500, 'engine_error')
    return [x / norm for x in vector]


def pooled(vectors, dimensions):
    if any(len(v) != 768 for v in vectors):
        raise RequestError('engine returned an unexpected dimension', 500, 'engine_error')
    unit = [normalize(v) for v in vectors]
    mean = [math.fsum(v[i] for v in unit) / len(unit) for i in range(dimensions)]
    return normalize(mean)

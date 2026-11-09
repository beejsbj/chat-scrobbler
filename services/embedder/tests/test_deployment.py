"""Render deployment plans without building images or starting services."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import unittest

ROOT = Path(__file__).resolve().parents[3]


def compose(*options, overrides=None):
    env = {**os.environ, 'MCP_AUTH_TOKEN': 'test-only', 'INGEST_TOKEN': 'test-only',
           'COMPOSE_PROFILES': '', 'CHAT_SCROBBLER_EMBED_PROVIDER': '',
           'CHAT_SCROBBLER_EMBED_MODEL': '', 'CHAT_SCROBBLER_EMBED_BASE_URL': '',
           **(overrides or {})}
    result = subprocess.run(['docker', 'compose', '-f', str(ROOT / 'docker-compose.bjslab.yml'),
                             *options, 'config', '--format', 'json'],
                            env=env, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which('docker'), 'rendered deployment regression requires Docker Compose')
class DeploymentTests(unittest.TestCase):
    def test_main_compose_always_runs_embedder_and_has_no_ollama(self):
        plan = compose()
        self.assertNotIn('ollama', plan['services'])
        self.assertNotIn('OLLAMA_BASE_URL', json.dumps(plan))
        service = plan['services']['embedder']
        self.assertEqual(service['user'], '1001:1001')
        self.assertNotIn('profiles', service)
        self.assertFalse(service.get('ports'))
        self.assertEqual(service['networks'], {'embeddings': None})
        self.assertTrue(plan['networks']['embeddings']['internal'])
        self.assertEqual(int(service['mem_limit']), 2 * 1024**3)
        self.assertEqual(int(service['memswap_limit']), 2 * 1024**3)
        self.assertEqual(float(service['cpus']), 2)
        self.assertIn('healthcheck', service)
        self.assertNotIn('/spikes/', json.dumps(service))
        scrobbler = plan['services']['scrobbler']
        self.assertIn('embedder', scrobbler['depends_on'])
        self.assertNotIn('ollama', scrobbler['depends_on'])
        env = scrobbler['environment']
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_PROVIDER'], 'embeddinggemma')
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_MODEL'], 'litert-community/embeddinggemma-2-740m-litert-lm')
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_BASE_URL'], 'http://embedder:4320')

    def test_coolify_can_still_override_provider_and_model(self):
        plan = compose(overrides={
            'CHAT_SCROBBLER_EMBED_PROVIDER': 'hash',
            'CHAT_SCROBBLER_EMBED_MODEL': 'test-model'})
        env = plan['services']['scrobbler']['environment']
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_PROVIDER'], 'hash')
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_MODEL'], 'test-model')


if __name__ == '__main__':
    unittest.main()

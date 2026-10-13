"""Render deployment plans without building images or starting services."""
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]


def compose(*options):
    env = {**os.environ, 'MCP_AUTH_TOKEN': 'test-only', 'INGEST_TOKEN': 'test-only',
           'COMPOSE_PROFILES': ''}
    result = subprocess.run(['docker', 'compose', '-f', str(ROOT / 'docker-compose.bjslab.yml'),
                             *options, 'config', '--format', 'json'],
                            env=env, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


class DeploymentTests(unittest.TestCase):
    def test_main_compose_opt_in_never_blocks_production_ollama(self):
        default = compose()
        self.assertNotIn('embedder', default['services'])
        enabled = compose('--profile', 'embeddings')
        service = enabled['services']['embedder']
        self.assertEqual(service['user'], '1001:1001')
        self.assertEqual(service['profiles'], ['embeddings'])
        self.assertFalse(service.get('ports'))
        self.assertEqual(service['networks'], {'embeddings': None})
        self.assertTrue(enabled['networks']['embeddings']['internal'])
        self.assertEqual(int(service['mem_limit']), 2 * 1024**3)
        self.assertEqual(int(service['memswap_limit']), 2 * 1024**3)
        self.assertEqual(float(service['cpus']), 2)
        scrobbler = enabled['services']['scrobbler']
        self.assertNotIn('embedder', scrobbler['depends_on'])
        self.assertEqual(scrobbler['environment']['CHAT_SCROBBLER_EMBED_PROVIDER'], 'ollama')
        self.assertEqual(scrobbler['environment']['CHAT_SCROBBLER_EMBED_MODEL'], 'nomic-embed-text')
        self.assertEqual(scrobbler['environment']['OLLAMA_BASE_URL'], 'http://ollama:11434')
        self.assertNotIn('/spikes/', json.dumps(service))


if __name__ == '__main__':
    unittest.main()

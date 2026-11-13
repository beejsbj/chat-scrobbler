"""Render deployment plans without building images or starting services."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import unittest

ROOT = Path(__file__).resolve().parents[3]


def compose(*options, overrides=None, files=('docker-compose.yml',)):
    env = {**os.environ, 'MCP_AUTH_TOKEN': 'test-only', 'INGEST_TOKEN': 'test-only', 'DATA_DIR': './data',
           'COMPOSE_PROFILES': '', 'CHAT_SCROBBLER_EMBED_PROVIDER': '',
           'CHAT_SCROBBLER_EMBED_MODEL': '', 'CHAT_SCROBBLER_EMBED_BASE_URL': '',
           **(overrides or {})}
    result = subprocess.run(['docker', 'compose', *[a for f in files for a in ('-f', str(ROOT / f))],
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
        self.assertEqual(service['user'], '999:999')
        self.assertEqual(service['build']['args'], {'DATA_UID': '999', 'DATA_GID': '999'})
        self.assertEqual(plan['services']['scrobbler']['build']['args'], {'DATA_UID': '999', 'DATA_GID': '999'})
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

    def test_overlay_leaves_the_embedder_out_and_turns_semantic_search_off(self):
        plan = compose(files=('docker-compose.yml', 'docker-compose.no-embedder.yml'))
        self.assertNotIn('embedder', plan['services'])
        scrobbler = plan['services']['scrobbler']
        self.assertEqual(scrobbler['environment']['CHAT_SCROBBLER_EMBED_PROVIDER'], 'none')
        self.assertFalse(scrobbler['depends_on']['embedder']['required'])

    def test_data_owner_can_be_set_once_for_both_images(self):
        plan = compose(overrides={'DATA_UID': '2000', 'DATA_GID': '2001'})
        self.assertEqual(plan['services']['embedder']['user'], '2000:2001')
        for name in ('embedder', 'scrobbler'):
            self.assertEqual(plan['services'][name]['build']['args'], {'DATA_UID': '2000', 'DATA_GID': '2001'})

    def test_coolify_can_still_override_provider_and_model(self):
        plan = compose(overrides={
            'CHAT_SCROBBLER_EMBED_PROVIDER': 'hash',
            'CHAT_SCROBBLER_EMBED_MODEL': 'test-model'})
        env = plan['services']['scrobbler']['environment']
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_PROVIDER'], 'hash')
        self.assertEqual(env['CHAT_SCROBBLER_EMBED_MODEL'], 'test-model')


class DeploymentFileTests(unittest.TestCase):
    """Text checks that run without Docker: both images and compose agree on the data owner."""

    def test_images_and_compose_default_to_the_same_owner(self):
        for path in ('Dockerfile', 'services/embedder/Dockerfile'):
            text = (ROOT / path).read_text()
            self.assertIn('ARG DATA_UID=999', text, path)
            self.assertIn('ARG DATA_GID=999', text, path)
        self.assertIn('--uid "${DATA_UID}"', (ROOT / 'Dockerfile').read_text())
        embedder = (ROOT / 'services/embedder/Dockerfile').read_text()
        self.assertIn('chown "${DATA_UID}:${DATA_GID}" /var/cache/embedder', embedder)
        self.assertNotIn('1001', embedder)
        text = (ROOT / 'docker-compose.yml').read_text()
        self.assertIn('user: "${DATA_UID:-999}:${DATA_GID:-999}"', text)
        self.assertEqual(text.count('DATA_UID: ${DATA_UID:-999}'), 2)
        self.assertNotIn('1001', text)

    def test_embedder_is_optional_without_editing_the_main_file(self):
        main = (ROOT / 'docker-compose.yml').read_text()
        self.assertIn('required: false', main)
        self.assertIn('CHAT_SCROBBLER_EMBED_PROVIDER: ${CHAT_SCROBBLER_EMBED_PROVIDER:-embeddinggemma}', main)
        self.assertNotIn('profiles', main)  # the default deployment keeps the sidecar on
        overlay = (ROOT / 'docker-compose.no-embedder.yml').read_text()
        self.assertIn('profiles: ["embedder-disabled"]', overlay)
        self.assertIn('CHAT_SCROBBLER_EMBED_PROVIDER: none', overlay)

    def test_embedder_keeps_its_hardening_and_gets_a_fresh_cache_volume(self):
        text = (ROOT / 'docker-compose.yml').read_text()
        for line in ('read_only: true', '- ALL', 'no-new-privileges:true', 'embedder-cache-v2:/var/cache/embedder'):
            self.assertIn(line, text)
        self.assertNotIn('embedder-cache:', text)


if __name__ == '__main__':
    unittest.main()

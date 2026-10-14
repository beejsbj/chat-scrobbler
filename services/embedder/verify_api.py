"""Audit installed Python source without importing LiteRT or opening the model."""
import argparse
import ast
import hashlib
import json
from pathlib import Path

from .config import SPIKE


def verify(package):
    source = package / 'embedding_engine.py'
    text = source.read_text()
    tree = ast.parse(text)
    classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}
    engine = classes['EmbeddingEngine']
    methods = {node.name: node for node in engine.body if isinstance(node, ast.FunctionDef)}
    parameters = {arg.arg for arg in methods['__init__'].args.args}
    required = {'model_path', 'backend', 'vision_backend', 'audio_backend', 'cache_dir',
                'max_input_length', 'vision_tokens_per_image'}
    if not required <= parameters or not {'compute_embedding', 'close'} <= methods.keys():
        raise RuntimeError('installed EmbeddingEngine contract differs')
    options = {node.target.id for node in classes['EmbeddingOptions'].body
               if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)}
    if not {'normalize', 'input_overflow_strategy', 'vision_tokens_per_image'} <= options:
        raise RuntimeError('installed EmbeddingOptions contract differs')
    symbols = ['litert_lm_embedding_engine_settings_set_vision_tokens_per_image',
               'litert_lm_embedding_options_set_vision_tokens_per_image',
               'litert_lm_embedding_engine_settings_set_num_threads',
               'litert_lm_embedding_engine_settings_set_audio_num_threads']
    ffi = (package / '_ffi.py').read_text()
    if not all(symbol in text and symbol in ffi for symbol in symbols):
        raise RuntimeError('required settings are not wired to native FFI')
    return {'source': str(source), 'sha256': hashlib.sha256(text.encode()).hexdigest(),
            'engine_parameters': sorted(required), 'option_fields': sorted(options),
            'native_settings_verified': symbols,
            'vision_thread_setter_exposed': 'set_vision_num_threads' in text,
            'model_imported': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=SPIKE / 'venv-a/lib/python3.12/site-packages/litert_lm')
    print(json.dumps(verify(parser.parse_args().package), indent=2))


if __name__ == '__main__':
    main()

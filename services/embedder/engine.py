"""The only module importing LiteRT, and only when an engine is requested."""


class LiteRTEngine:
    def __init__(self, config):
        # Never use from-huggingface helpers: local files only, no downloads.
        if not config.model_path.is_file() or not config.cache_dir.is_dir():
            raise RuntimeError('local model file and existing cache directory required')
        import litert_lm as lm
        from litert_lm._messages import AudioFile, ImageFile
        self.image_file, self.audio_file = ImageFile, AudioFile
        self.options = lm.EmbeddingOptions(
            normalize=True, vision_tokens_per_image=140,
            input_overflow_strategy=lm.InputOverflowStrategy.ERROR)
        self.native = lm.EmbeddingEngine(
            str(config.model_path), backend=lm.Backend.CPU(thread_count=2),
            vision_backend=lm.Backend.CPU(thread_count=2),
            audio_backend=lm.Backend.CPU(thread_count=2),
            cache_dir=str(config.cache_dir), max_input_length=config.max_input_length,
            vision_tokens_per_image=140)

    def embed(self, content):
        if isinstance(content, list):
            content = [self.image_file(str(p.path)) if p.kind == 'image'
                       else self.audio_file(str(p.path)) for p in content]
        return self.native.compute_embedding(content, self.options).embedding

    def close(self):
        self.native.close()

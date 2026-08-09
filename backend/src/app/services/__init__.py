"""Runtime services: ONNX inference, score post-processing and caching.

``postprocess`` and ``cache`` deliberately import nothing heavier than numpy and
the standard library, so the decision logic is testable without onnxruntime, the
tokenizer or the 951 MB graph.
"""

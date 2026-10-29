"""Rebuilds functions' voice model: SpeechBrain ECAPA (spkrec-ecapa-voxceleb)
with its feature front-end, exported to ONNX. torch.stft does not export, so
the STFT is replaced by the same DFT as a convolution (checked to 1e-3 on the
spectrum, cosine 1.0 on the embedding). Upload the result to the bucket as
models/ecapa-voxceleb.onnx (functions/voice.js MODEL_OBJECT).

    python -I tools/voiceprint-export.py <speechbrain model dir> <out.onnx>
Needs torch, speechbrain, onnx, onnxruntime (the voiceprint venv).
"""
import torch, sys
from speechbrain.inference.speaker import EncoderClassifier
enc = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=sys.argv[1], run_opts={"device":"cpu"})
m = enc.mods
st = m.compute_features.compute_STFT
print("stft", st.n_fft, st.hop_length, st.win_length, st.center, st.pad_mode, st.normalized_stft, st.onesided)
orig = st.forward
N = st.n_fft
k = torch.arange(N//2+1).float()[:, None]; t = torch.arange(N).float()[None, :]
w = torch.zeros(N); off=(N-st.win_length)//2; w[off:off+st.win_length]=st.window
COS = (torch.cos(2*torch.pi*k*t/N)*w).T.contiguous(); SIN = (-torch.sin(2*torch.pi*k*t/N)*w).T.contiguous()
KER = torch.cat([COS.T, SIN.T], 0)[:, None, :]
def fwd(x):
    x = torch.nn.functional.pad(x, (N//2, N//2))
    y = torch.nn.functional.conv1d(x[:, None, :], KER, stride=st.hop_length).transpose(1, 2)
    F2 = N//2+1
    return torch.stack([y[..., :F2], y[..., F2:]], -1)
xx = torch.randn(2, 30000)
print("stft diff", float((orig(xx)-fwd(xx)).abs().max()), orig(xx).shape, fwd(xx).shape)
st.forward = fwd
class Full(torch.nn.Module):
    def __init__(s): super().__init__(); s.f=m.compute_features; s.n=m.mean_var_norm; s.e=m.embedding_model
    def forward(s, wav):
        x = s.f(wav); x = s.n(x, torch.ones(1)); return s.e(x, torch.ones(1)).squeeze(1)
full = Full().eval()
x = torch.randn(1, 48000)
with torch.no_grad(): ref = full(x)
torch.onnx.export(full, (x,), sys.argv[2], input_names=["wav"], output_names=["emb"], dynamic_axes={"wav":{1:"n"}}, opset_version=17, dynamo=False)
import onnxruntime as ort, numpy as np
s = ort.InferenceSession(sys.argv[2])
for n in (48000, 160000):
    x = torch.randn(1, n)
    with torch.no_grad(): a = full(x).numpy().ravel()
    b = s.run(None, {"wav": x.numpy()})[0].ravel()
    print(n, "cos", float(a@b/np.linalg.norm(a)/np.linalg.norm(b)))

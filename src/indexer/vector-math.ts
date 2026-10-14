export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; a2 += a[i]*a[i]; b2 += b[i]*b[i]; }
  return a2 && b2 ? dot / Math.sqrt(a2*b2) : 0;
}

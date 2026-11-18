export const miloAxes = ["X", "Y", "Z"] as const;
export const miloAxisColors = ["#62dbab", "#80bfff", "#f0b66e"] as const;
export const miloNumber = (value: number) => String(Number(value.toPrecision(6)));

export function tickStep(span: number) {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  if (!magnitude) return span;
  const fraction = span / magnitude;
  return magnitude * (fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10);
}

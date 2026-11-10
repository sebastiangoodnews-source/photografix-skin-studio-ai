/**
 * Mask overlay for the preview.
 *
 * Coverage is drawn as a lilac wash plus a contour line at 50% coverage, which is
 * how a retoucher reads a selection: the wash shows where the tool will act, the
 * contour shows the edge that Photoshop will use for the layer mask.
 */
export const darkenMaskOverlay = (rgba, mask, width, height, strength = 0.6) => {
  const tint = [179, 136, 255];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const m = mask[p];
      if (m <= 0.02) continue;
      const i = p * 4;
      const alpha = Math.min(1, m * strength);
      // wash
      rgba[i] = Math.round(rgba[i] * (1 - alpha * 0.45) + tint[0] * alpha * 0.45);
      rgba[i + 1] = Math.round(rgba[i + 1] * (1 - alpha * 0.45) + tint[1] * alpha * 0.45);
      rgba[i + 2] = Math.round(rgba[i + 2] * (1 - alpha * 0.45) + tint[2] * alpha * 0.45);
      // 50% contour
      const right = x + 1 < width ? mask[p + 1] : m;
      const down = y + 1 < height ? mask[p + width] : m;
      const crossing = (m >= 0.5 && (right < 0.5 || down < 0.5)) || (m < 0.5 && (right >= 0.5 || down >= 0.5));
      if (crossing) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
      }
    }
  }
  return rgba;
};

/** Dim everything outside the mask - used by the "focus" preview toggle. */
export const spotlightMask = (rgba, mask, strength = 0.55) => {
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    const dim = 1 - (1 - mask[p]) * strength;
    rgba[i] *= dim;
    rgba[i + 1] *= dim;
    rgba[i + 2] *= dim;
  }
  return rgba;
};

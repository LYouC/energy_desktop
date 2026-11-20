import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../src/renderer/style.css", import.meta.url),
  "utf8",
);
function luminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((value) => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
for (const theme of [":root", ":root.dark"]) {
  const block = css.slice(css.indexOf(`${theme} {`)).split("}")[0];
  const colors = Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  for (const foreground of ["ink", "text", "muted", "accent"]) {
    test(`${theme} ${foreground} 在各表面正文对比度至少 4.5`, () => {
      for (const background of [
        "bg",
        "rail",
        "surface",
        "chat",
        "soft",
        "energy",
      ]) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(
          ratio >= 4.5,
          `${foreground}/${background} 为 ${ratio.toFixed(3)}:1`,
        );
      }
    });
  }
  test(`${theme} 主按钮文字及控件边界对比度`, () => {
    assert.ok(contrast(colors["button-ink"], colors.button) >= 4.5);
    for (const background of [
      "bg",
      "rail",
      "surface",
      "chat",
      "soft",
      "energy",
    ])
      assert.ok(contrast(colors.control, colors[background]) >= 3);
  });
}

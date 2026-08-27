# Screenshot fixtures

Real screenshots of the game, each paired with what a person read off it by
eye. `npm run ocr:accuracy` sends every image here through the same prompt and
validation the live endpoint uses, and reports how much of the ground truth it
got exactly right.

This is the only honest measure of whether the feature works. Unit tests prove
that a malformed answer is rejected; they cannot prove that a real screenshot
is read correctly, and no amount of them adds up to that.

## Adding one

Two files with the same stem:

    market-fiji-bay.png            the screenshot, untouched
    market-fiji-bay.expected.json  what it actually says

The JSON:

```json
{
  "screen": "market",
  "portName": "Fiji Bay",
  "rows": [
    { "goodId": "copper", "sell": "22.0", "stock": "40" },
    { "goodId": "silk",   "sell": "48.9", "stock": null }
  ]
}
```

Rules for the expected file, which are the same rules the model is given:

- Copy the digits exactly as printed, as strings. `"18.9"`, never `18.9` — a
  JSON number puts money in a float, and the whole codebase forbids that.
- `null` means the screen does not show that value. It does not mean zero.
- Omit a good entirely if it is not on the screen.
- `goodId` must be an id from `data/goods.json` or `data/resources.json`.

## Screenshots are not stored anywhere else

Images live here, in the repository, deliberately — they are game UI, not
personal data, and having them under version control is what makes a prompt
change measurable against the same evidence twice. The running app never stores
an uploaded image anywhere (SPEC.md 7.2, safeguard 5).

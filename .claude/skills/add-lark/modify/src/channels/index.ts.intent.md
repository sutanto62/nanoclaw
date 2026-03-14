# Intent: Add Lark channel import

Add `import './lark.js';` to the channel barrel file so the Lark
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved. Lark's import sits between gmail and slack alphabetically.

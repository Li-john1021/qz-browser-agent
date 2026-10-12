# Local conversation samples

Place qz HTML exports here to replay them with the current renderer. JSON files with a nonempty
`transcript` array are also supported; [stub.json](stub.json) shows the format. The benchmark treats
exports as recorded data and simulates Chrome APIs.

```bash
npm run benchmark -- conversation --real-examples
npm run benchmark -- conversation --real-examples --mode snapshot-render
npm run benchmark -- conversation --real-examples --mode stream-fixture-expanded
```

The runner reads `.html`, `.htm`, and `.json` files in filename order, with a fresh browser context
per sample. It skips subdirectories, symbolic links, hidden files, and `stub.json`. All samples run;
any failure or an empty corpus gives the command a failure status. Private samples are optional.

Reports default to `tests/results/conversation-real-examples/<timestamp>/`. `summary.json` records
each sample's status; `sample-N/` holds its evidence. Use `--artifact-dir` for another output root.
For single-file screenshots or baseline comparisons, pass a sample path directly.

Git tracks this README and the synthetic stub; other files and subdirectories are ignored. Keep real
conversations and their reports private, and review screenshots before sharing them.

For randomized scrolling and reading pauses, add `--stream-fuzz-seed 12345` to
`stream-fixture-interaction`. The runner checks completed tool cards each frame. Use different seeds
for repeated runs. The [test guide](../../../README.md#benchmarks-and-visual-checks) also covers
combined expansion, font-size, and viewport fuzzing. Keep its sample-path manifest in
`tests/results/`; this directory holds the conversation exports themselves.

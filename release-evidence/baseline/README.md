# V2.27 baseline evidence

The immutable source is commit `5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed`
and tree `1025debb9c1d76f41fad3ed9d2ded8b3afa71d7b`.

`v227-tracked-files.sha256` is the release-independent manifest of every tracked
blob. `v227-baseline.json` records the exact browser capture environment and the
hash and dimensions of every screenshot. Captures use Playwright 1.58.2 with
Chrome for Testing 145.0.7632.6 at device scale factor 1.

The path, DOM subtree and CSS selector boundaries live in
`v227-allowlist.json`. Existing files may not be deleted. Existing public pages
outside the named content subtrees remain structurally protected, and CSS rules
outside the page-scoped selector namespaces remain byte-semantically protected.
Unrelated cleanup is therefore deliberately rejected.

Recreate the evidence from the Git object, never from the working tree:

    python3 scripts/capture_v227_baseline.py --repo .

Run the guardrails:

    python3 scripts/check_v227_allowlist.py --repo . --baseline 5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed
    python3 scripts/check_local_refs.py .

`visual-diff-policy.json` stores the accepted thresholds. Approved dynamic
regions are masked for the protected comparison; the unmasked full-page ceiling
exists only as a broad regression alarm.

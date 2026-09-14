# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose recorded content. Use GitHub's private vulnerability reporting feature for this repository.

## Capture boundaries

ClipQA records only the window explicitly identified by title or HWND. It does not capture audio, read keyboard input, inject mouse input, upload recordings, or start a network listener. Recordings remain in the configured local data directory until the user removes them.

Treat recordings as potentially sensitive. Review them before sharing and avoid recording windows that contain private information.

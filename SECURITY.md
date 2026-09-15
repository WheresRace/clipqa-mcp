# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose recorded content. Use GitHub's private vulnerability reporting feature for this repository.

## Capture boundaries

Windows and X11 backends record the selected window; the macOS backend records an explicitly selected display, including other visible applications. ClipQA does not capture audio or webcams, read keyboard input, inject input, activate windows, or start a network listener. Imported videos are copied as supplied and can contain audio or other material from the original recorder.

ClipQA does not upload videos itself. Images returned over MCP go to the connected client and can be forwarded by that client to its AI provider. Video links refer to local files. Recordings, exported previews and reports stay local until the user invokes cleanup or removes them. Only old working segments in rolling mode are pruned automatically.

The optional `--setup-wgc` command downloads FFmpeg from the documented build provider and verifies its published SHA-256. Normal recording and analysis do not download software. Imported media probing/analysis restrict FFmpeg input protocols to local files and pipes.

Treat recordings as potentially sensitive. Review them before sharing and avoid recording windows that contain private information.

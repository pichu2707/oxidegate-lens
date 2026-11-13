# Regenerate from the repo root: vhs docs/media/tapes/sessions.tape
# Uses invented sample data (docs/media/demo-proxy.mjs) and a throwaway HOME (/tmp/demo): nothing real is read or written.
Output docs/media/sessions.gif
Set Shell bash
Set FontSize 16
Set Width 1100
Set Height 600
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set Framerate 20

Hide
Type "source docs/media/demo-env.sh && clear" Enter
Sleep 2s
Show
Type "oxidegate-sessions | sed -n 1,7p" Sleep 500ms Enter
Sleep 5s

Hide
Type "kill $DEMO_PID; rm -rf /tmp/demo" Enter

Video pack (hermilinChat)

This folder contains static demo runner templates + a small installer intended for video recordings.

Install on a target machine:
  cd /path/to/hermilinChat
  ./scripts/update.sh --skip-hermes-patch   # optional; ensure hermilinChat deps
  ./.venv/bin/python scripts/install_video_pack.py --env-file .hermelin.env --force

What install_video_pack.py does:
- Reads HERMES_HOME from the provided env file (or --hermes-home)
- Copies templates into $HERMES_HOME/artifacts/runners/projects/{gpu,builder,strudel,money}/
- Enables the Hans "video director" system prompt in $HERMES_HOME/config.yaml (backup is created)

What it does NOT do:
- It does NOT patch Hermes code or install the artifact tools. (Do that separately; your isolated Hermes env already has it.)

After install:
- Restart hermilinChat
- In chat, type one of: GPU / BUILDER / STRUDEL / MONEY

Uninstall:
  ./.venv/bin/python scripts/uninstall_video_pack.py --env-file .hermelin.env --remove-templates

On-camera tip:
Hermes CLI auto-collapses large multi-line pastes. For the video, paste a single paragraph,
or split the prompt into 2 messages.

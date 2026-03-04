# AI Story Writer

Web app for writing a story one part at a time with either:
- a local Ollama model, or
- an OpenAI-compatible API endpoint.

## Features
- Generate the next story part from:
  - optional story overview
  - current story text (`storySoFar`)
  - what happens next
  - optional story arc instruction
- Set any paragraph count per generated part (minimum 1)
- Keep story context across parts
- Save story locally as JSON in this format:
  - `format`, `title`, `storyOverview`, `storySoFar`, `whatHappensNext`, `storyArcInstruction`, `paragraphLimit`
- Load a previously saved JSON story
- Separate `/settings` page for model/API configuration

## Requirements
- Python 3.10+
- One of:
  - local Ollama endpoint (`POST /api/chat`)
  - OpenAI-compatible `chat/completions` API

## Run
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Then open:
- `http://127.0.0.1:5000`

Configure model settings at:
- `http://127.0.0.1:5000/settings`

## Notes
- `title` and `storyOverview` are optional.
- The app requests an exact paragraph count and applies a fallback paragraph normalizer if the model response does not match.


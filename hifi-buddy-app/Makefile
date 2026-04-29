.PHONY: validate lint test serve clean

validate:
	@python3 tools/validate_data.py

lint:
	@python3 tools/lint_lessons.py

test: validate lint
	@for f in js/*.js; do node -c "$$f" || exit 1; done
	@python3 -m py_compile server.py propose_lessons.py
	@echo "All tests passed."

serve:
	@PORT=8091 python3 server.py

clean:
	@rm -f local-library-index.json
	@# The transcoded-MP3 cache lives next to your music library at
	@# `<your-music-folder>/.hifi-buddy-cache/`. We don't auto-wipe it here
	@# because it could be large and is outside this repo. To clear it:
	@#   rm -rf "<your-music-folder>/.hifi-buddy-cache"
	@echo "Cleaned local-library index. (ABX transcode cache lives next to your music — see Makefile note.)"

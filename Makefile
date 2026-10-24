.PHONY: test test-extension test-installer package check

test: test-extension test-installer

test-extension:
	cd extension && node --test tests/*.test.js

test-installer:
	python3 -m unittest discover -s tests -v

package:
	python3 scripts/package_release.py --version $$(cat VERSION)

check:
	python3 -m compileall -q scripts tests
	sh -n install.sh uninstall.sh
	cd extension && for script in *.js; do node --check "$$script" || exit; done

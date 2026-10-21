#!/bin/sh
# `adminforge` in the app image (the CLI bundle): kubectl exec deploy/adminforge -c api -- adminforge <command>
exec node /app/portal/tools/cli/dist/adminforge.js "$@"

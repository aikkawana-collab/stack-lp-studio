#!/bin/zsh
cd "$(dirname "$0")" || exit 1
npm run check || exit 1
npm start

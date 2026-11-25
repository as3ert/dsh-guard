@echo off
rem dsh-guard command line for Claude Code; needs Node.js 24 or later on PATH.
node "%~dp0..\dist\claude-code\cli.js" %*

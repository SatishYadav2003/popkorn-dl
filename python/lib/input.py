"""Keyboard input for whole lines: the login code, and everything when input is piped.
(The full-screen UI reads single keys itself, in ui/tui.py.)"""
import asyncio
import sys

interactive = sys.stdin.isatty() and sys.stdout.isatty()


async def ask(prompt):
    # In a thread, so waiting for you doesn't block the Telegram connection.
    return (await asyncio.to_thread(input, prompt)).strip()

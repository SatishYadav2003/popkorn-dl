"""Removes what the script leaves in Telegram, so the bot chat and Saved Messages
only keep what you did by hand.

A trail is the set of bot-chat messages the script sent or got back during one
search or one download.
"""
from . import telegram as tg
from .ui import ui


async def clear_trail(trail):
    if not trail:
        return
    try:
        await tg.client.delete_messages(tg.bot, list(trail), revoke=True)
    except Exception as e:
        ui.notify("warning", f"Couldn't clean up the bot chat: {e}")
    trail.clear()


async def delete_saved(ids):
    try:
        await tg.client.delete_messages("me", ids, revoke=True)
    except Exception:
        pass  # already gone; nothing else to do

"""The Telegram connection, logged in as you, and the bot it talks to.

Other modules use it as `tg.client` / `tg.bot`; `bot` is set by connect().
"""
import asyncio
import os

from telethon import TelegramClient, events

from .config import SESSION_FILE

client = TelegramClient(str(SESSION_FILE), int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
bot = None


async def connect():
    """Logs in (asks for the code only when there's no valid session yet) and finds the bot."""
    global bot
    await client.start(phone=os.environ["TG_PHONE"])
    bot = await client.get_entity(os.environ["BOT_USERNAME"])


async def wait_for(predicate, timeout, trail):
    """Next incoming (or edited) bot message that satisfies predicate, else None.

    Every bot message seen meanwhile goes into trail, so it can be cleaned up later.
    """
    fut = asyncio.get_running_loop().create_future()

    async def handler(event):
        trail.add(event.message.id)
        if not fut.done() and predicate(event.message):
            fut.set_result(event.message)

    evs = (events.NewMessage(chats=bot, incoming=True), events.MessageEdited(chats=bot, incoming=True))
    for ev in evs:
        client.add_event_handler(handler, ev)
    try:
        return await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        return None
    finally:
        client.remove_event_handler(handler)

"""POPKORN: search the bot, pick a result, and download it or stream it to a
video player. Same as doing it by hand in Telegram, but the script does the
tapping. The pieces live in lib/; colours, text and the bot's format in ../shared/.
"""
import asyncio

from lib import telegram as tg
from lib.bot import describe_result, file_buttons, page_info, send_search, turn_page
from lib.cleanup import clear_trail
from lib.config import download_dir
from lib.download import download
from lib.library import marker_for, scan_local
from lib.shared import fmt, strings
from lib.stream import stream
from lib.ui import ui


async def main():
    await tg.connect()  # may ask for the login code, so before the full-screen UI starts
    ui.start(bot=tg.bot.username, dir=str(download_dir.resolve()))
    try:
        while True:
            query = await ui.ask_query()
            if not query:
                break
            trail = set()
            try:
                await browse(query, trail)
            finally:
                await clear_trail(trail)
    finally:
        ui.stop()
    await tg.client.disconnect()


async def browse(query, trail):
    """Browse the results page by page, like in Telegram, until a file is picked or you leave."""
    msg = await ui.busy(fmt(strings["searching"], query=query), send_search(query, trail))
    if not msg:
        ui.notify("warning", fmt(strings["nothingFound"], query=query))
        return

    while True:
        results = file_buttons(msg)
        page, total = page_info(msg)
        local = scan_local()  # fresh each time: a download may have just finished
        items = []
        for b in results:
            result = describe_result(b.text)
            items.append({**result, "marker": marker_for(result, local)})
        action, index = await ui.pick_result(query, items, page, total)

        if action == "back":
            return
        if action in ("next", "prev"):
            want = page + (1 if action == "next" else -1)
            new = await ui.busy(fmt(strings["loadingPage"], page=want), turn_page(msg, action, trail))
            if new:
                msg = new
            else:
                ui.notify("warning", strings["pageFailed"])
            continue
        # Done with this search once the file is down or watched; leaving it cleans up the chat.
        button = results[index]
        if await (stream(button) if action == "stream" else download(button)):
            return


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n{strings['cleaningUp']}")

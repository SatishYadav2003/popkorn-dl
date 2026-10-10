"""POPKORN: search the bot or MovieBox, pick a result, and download it or stream it.
The pieces live in lib/; colours, text and the bot's format in ../shared/.
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
from lib.moviebox import browse as moviebox_browse


async def main():
    await tg.connect()  # may ask for the login code, so before the full-screen UI starts
    ui.start(bot=tg.bot.username, dir=str(download_dir.resolve()))
    try:
        while True:
            result = await ui.ask_query()
            if not result:
                break
            query, source = result
            trail = set()
            try:
                if source == "moviebox":
                    await moviebox_browse.browse(query)
                else:
                    await browse(query, trail)
            finally:
                if source != "moviebox":
                    await clear_trail(trail)
    finally:
        ui.stop()
    await tg.client.disconnect()


async def browse(query, trail):
    """Browse the Telegram results page by page until a file is picked or you leave."""
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
        choice = await ui.pick_result(query, items, page, total)

        action = choice["action"]
        index = choice["index"]

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
        # Done with this search once the file is down or watched.
        button = results[index]
        if await (stream(button) if action == "stream" else download(button)):
            return


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n{strings['cleaningUp']}")

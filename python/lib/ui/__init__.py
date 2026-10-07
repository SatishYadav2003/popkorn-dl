"""The one UI everything talks to: the full-screen app with a keyboard, the
line-by-line one when input is piped in."""
from ..input import interactive
from .plain import Plain
from .tui import Tui

ui = Tui() if interactive else Plain()

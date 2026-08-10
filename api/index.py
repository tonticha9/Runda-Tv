import sys
import os

# Ruhusu import ya app.py iliyoko folder mama (root ya project)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import app  # noqa: E402

# Vercel Python runtime inatafuta variable inayoitwa "app" (WSGI callable)

# Plotting with matplotlib in RunPython

Reference card for matplotlib usage inside `RunPython`. Fetched on demand via `CallSkill('matplotlib')`.

For any chart, plot, or figure, use matplotlib (`import matplotlib.pyplot as plt`). Create figures normally — the host already configures the AGG backend and captures every open figure as a PNG after your code runs, then displays them in the Python tab's "Plot" sub-tab. **Do not call `plt.show()`** — it emits `UserWarning: FigureCanvasAgg is non-interactive` and does nothing useful here. Do not call `matplotlib.use(...)` either. Each call starts with no open figures, so plots from a prior `RunPython` call don't leak in. Plots are static images (no zoom / pan).

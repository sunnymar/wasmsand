"""
matplotlib.figure — Figure class.
"""

from matplotlib.axes import Axes


class Figure:
    """Top-level container for a matplotlib plot."""

    def __init__(self, figsize=None, dpi=100):
        self.figsize = figsize or (6.4, 4.8)
        self.dpi = dpi
        self._axes = []

    def add_subplot(self, nrows=1, ncols=1, index=1):
        """Add an Axes to the figure."""
        pos = (nrows, ncols, index)
        ax = Axes(self, pos)
        self._axes.append(ax)
        return ax

    @property
    def axes(self):
        return list(self._axes)

    def savefig(self, fname, format=None, dpi=None):
        """Save figure to *fname*.  Format inferred from extension if not given."""
        dpi = dpi or self.dpi
        if format is None and isinstance(fname, str):
            if fname.lower().endswith('.png'):
                format = 'png'
            elif fname.lower().endswith('.svg'):
                format = 'svg'
            else:
                format = 'svg'

        if format == 'png':
            from matplotlib._pil_backend import render_figure_png
            data = render_figure_png(self, dpi)
            with open(fname, 'wb') as f:
                f.write(data)
        else:
            from matplotlib._svg_backend import render_figure_svg
            svg = render_figure_svg(self)
            with open(fname, 'w') as f:
                f.write(svg)

"""
matplotlib.axes — Axes class that stores plot elements.
"""

from matplotlib.colors import DEFAULT_CYCLE, to_hex, parse_fmt


class Axes:
    """A single set of axes in a Figure."""

    def __init__(self, fig, position):
        self.figure = fig
        self._position = position
        self._elements = []
        self._title = ''
        self._xlabel = ''
        self._ylabel = ''
        self._xlim = None
        self._ylim = None
        self._grid = False
        self._legend = False
        self._color_idx = 0

    def _next_color(self):
        c = DEFAULT_CYCLE[self._color_idx % len(DEFAULT_CYCLE)]
        self._color_idx += 1
        return c

    # ------------------------------------------------------------------
    # Plot types
    # ------------------------------------------------------------------

    def plot(self, *args, **kwargs):
        """Line plot.  Accepts ``plot(y)``, ``plot(x, y)``, ``plot(x, y, fmt)``."""
        x, y, fmt = _parse_plot_args(args)
        color_fmt, marker, linestyle = parse_fmt(fmt)
        color = kwargs.get('color') or kwargs.get('c')
        if color is None:
            color = color_fmt
        if color is None:
            color = self._next_color()
        color = to_hex(color)
        label = kwargs.get('label')
        linewidth = kwargs.get('linewidth', kwargs.get('lw', 1.5))
        if linestyle is None:
            linestyle = kwargs.get('linestyle', kwargs.get('ls', '-'))
        elem = {
            'type': 'line',
            'x': list(x), 'y': list(y),
            'color': color, 'linewidth': linewidth,
            'linestyle': linestyle, 'marker': marker,
            'label': label,
        }
        self._elements.append(elem)
        return [elem]

    def scatter(self, x, y, s=20, c=None, **kwargs):
        """Scatter plot."""
        color = c or kwargs.get('color') or self._next_color()
        color = to_hex(color)
        label = kwargs.get('label')
        elem = {
            'type': 'scatter',
            'x': list(x), 'y': list(y),
            's': s, 'color': color, 'label': label,
        }
        self._elements.append(elem)
        return elem

    def bar(self, x, height, width=0.8, **kwargs):
        """Bar chart."""
        color = kwargs.get('color') or self._next_color()
        color = to_hex(color)
        label = kwargs.get('label')
        # Convert x to list of values
        x_vals = list(x)
        h_vals = list(height)
        elem = {
            'type': 'bar',
            'x': x_vals, 'height': h_vals, 'width': width,
            'color': color, 'label': label,
        }
        self._elements.append(elem)
        return elem

    def hist(self, x, bins=10, **kwargs):
        """Histogram — compute bins, store as bar chart."""
        data = list(x)
        color = kwargs.get('color') or self._next_color()
        color = to_hex(color)
        label = kwargs.get('label')

        # Compute histogram bins
        lo = min(data)
        hi = max(data)
        if lo == hi:
            hi = lo + 1
        bin_width = (hi - lo) / bins
        edges = [lo + i * bin_width for i in range(bins + 1)]
        counts = [0] * bins
        for v in data:
            idx = int((v - lo) / bin_width)
            if idx >= bins:
                idx = bins - 1
            counts[idx] += 1

        centers = [(edges[i] + edges[i + 1]) / 2 for i in range(bins)]
        elem = {
            'type': 'bar',
            'x': centers, 'height': counts, 'width': bin_width * 0.9,
            'color': color, 'label': label,
        }
        self._elements.append(elem)
        return counts, edges, None

    # ------------------------------------------------------------------
    # Labels / config
    # ------------------------------------------------------------------

    def set_title(self, s):
        self._title = s

    def set_xlabel(self, s):
        self._xlabel = s

    def set_ylabel(self, s):
        self._ylabel = s

    def set_xlim(self, left=None, right=None):
        self._xlim = (left, right)

    def set_ylim(self, bottom=None, top=None):
        self._ylim = (bottom, top)

    def legend(self, **kwargs):
        self._legend = True

    def grid(self, visible=True, **kwargs):
        self._grid = visible


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _parse_plot_args(args):
    """Parse positional args for plot(): (y,), (x, y), (x, y, fmt)."""
    fmt = ''
    if len(args) == 1:
        y = list(args[0])
        x = list(range(len(y)))
    elif len(args) >= 2:
        first, second = args[0], args[1]
        if isinstance(second, str):
            # plot(y, fmt)
            y = list(first)
            x = list(range(len(y)))
            fmt = second
        else:
            x = list(first)
            y = list(second)
            if len(args) >= 3 and isinstance(args[2], str):
                fmt = args[2]
    else:
        x, y = [], []
    return x, y, fmt

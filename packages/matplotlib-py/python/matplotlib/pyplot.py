"""
matplotlib.pyplot — stateful module-level plotting API.
"""

from matplotlib.figure import Figure

# Global state
_figures = []
_current_fig = None
_current_ax = None


def _ensure():
    """Ensure there is a current Figure and Axes."""
    global _current_fig, _current_ax
    if _current_fig is None:
        fig, ax = subplots()
    return _current_fig, _current_ax


def figure(num=None, figsize=None, dpi=100):
    """Create a new Figure."""
    global _current_fig, _current_ax
    fig = Figure(figsize=figsize, dpi=dpi)
    ax = fig.add_subplot(1, 1, 1)
    _figures.append(fig)
    _current_fig = fig
    _current_ax = ax
    return fig


def subplots(nrows=1, ncols=1, figsize=None, dpi=100):
    """Create a Figure and a set of subplots."""
    global _current_fig, _current_ax
    fig = Figure(figsize=figsize, dpi=dpi)
    if nrows == 1 and ncols == 1:
        ax = fig.add_subplot(1, 1, 1)
        _figures.append(fig)
        _current_fig = fig
        _current_ax = ax
        return fig, ax
    axes = []
    for r in range(nrows):
        row = []
        for c in range(ncols):
            ax = fig.add_subplot(nrows, ncols, r * ncols + c + 1)
            row.append(ax)
        axes.append(row)
    _figures.append(fig)
    _current_fig = fig
    _current_ax = axes[0][0] if axes else None
    if nrows == 1:
        axes = axes[0]
    elif ncols == 1:
        axes = [row[0] for row in axes]
    return fig, axes


def gcf():
    """Get current figure."""
    _ensure()
    return _current_fig


def gca():
    """Get current axes."""
    _ensure()
    return _current_ax


# ------------------------------------------------------------------
# Plotting functions — delegate to current axes
# ------------------------------------------------------------------

def plot(*args, **kwargs):
    _ensure()
    return _current_ax.plot(*args, **kwargs)


def scatter(x, y, s=None, c=None, **kwargs):
    _ensure()
    kw = dict(kwargs)
    if s is not None:
        kw['s'] = s
    if c is not None:
        kw['c'] = c
    return _current_ax.scatter(x, y, **kw)


def bar(x, height, width=0.8, **kwargs):
    _ensure()
    return _current_ax.bar(x, height, width, **kwargs)


def hist(x, bins=10, **kwargs):
    _ensure()
    return _current_ax.hist(x, bins, **kwargs)


# ------------------------------------------------------------------
# Labels / config
# ------------------------------------------------------------------

def xlabel(s):
    _ensure()
    _current_ax.set_xlabel(s)


def ylabel(s):
    _ensure()
    _current_ax.set_ylabel(s)


def title(s):
    _ensure()
    _current_ax.set_title(s)


def xlim(left=None, right=None):
    _ensure()
    _current_ax.set_xlim(left, right)


def ylim(bottom=None, top=None):
    _ensure()
    _current_ax.set_ylim(bottom, top)


def legend(**kwargs):
    _ensure()
    _current_ax.legend(**kwargs)


def grid(visible=True, **kwargs):
    _ensure()
    _current_ax.grid(visible, **kwargs)


# ------------------------------------------------------------------
# Output
# ------------------------------------------------------------------

def savefig(fname, format=None, dpi=None):
    _ensure()
    _current_fig.savefig(fname, format=format, dpi=dpi)


def show():
    """No-op in sandbox environment."""
    pass


def close(fig='all'):
    """Close figure(s)."""
    global _current_fig, _current_ax, _figures
    if fig == 'all':
        _figures = []
        _current_fig = None
        _current_ax = None
    elif fig is _current_fig:
        if fig in _figures:
            _figures.remove(fig)
        _current_fig = _figures[-1] if _figures else None
        _current_ax = _current_fig._axes[-1] if _current_fig and _current_fig._axes else None

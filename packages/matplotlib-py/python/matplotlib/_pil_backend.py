"""
matplotlib._pil_backend — render a Figure to PNG bytes via PIL.
"""

from matplotlib.colors import to_rgb


def render_figure_png(fig, dpi=None):
    """Return PNG bytes for *fig*."""
    from PIL import Image, ImageDraw

    dpi = dpi or fig.dpi
    fw, fh = fig.figsize
    img_w = int(fw * dpi)
    img_h = int(fh * dpi)

    img = Image.new('RGB', (img_w, img_h), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    for ax in fig._axes:
        _render_axes(draw, ax, img_w, img_h)

    img.save('/tmp/_matplotlib_tmp.png')
    with open('/tmp/_matplotlib_tmp.png', 'rb') as f:
        return f.read()


def _render_axes(draw, ax, img_w, img_h):
    """Render one Axes onto the ImageDraw context."""
    ml, mr, mt, mb = 70, 20, 40, 50

    plot_x = ml
    plot_y = mt
    plot_w = img_w - ml - mr
    plot_h = img_h - mt - mb

    if plot_w <= 0 or plot_h <= 0:
        return

    # Data ranges
    xmin, xmax, ymin, ymax = _data_range(ax)

    if ax._xlim:
        if ax._xlim[0] is not None:
            xmin = ax._xlim[0]
        if ax._xlim[1] is not None:
            xmax = ax._xlim[1]
    if ax._ylim:
        if ax._ylim[0] is not None:
            ymin = ax._ylim[0]
        if ax._ylim[1] is not None:
            ymax = ax._ylim[1]

    dx = (xmax - xmin) or 1.0
    dy = (ymax - ymin) or 1.0
    xmin -= dx * 0.05
    xmax += dx * 0.05
    ymin -= dy * 0.05
    ymax += dy * 0.05

    def sx(v):
        return int(plot_x + (v - xmin) / (xmax - xmin) * plot_w)

    def sy(v):
        return int(plot_y + plot_h - (v - ymin) / (ymax - ymin) * plot_h)

    # Plot area border
    draw.rectangle([(plot_x, plot_y), (plot_x + plot_w, plot_y + plot_h)], outline=(0, 0, 0))

    # Grid
    if ax._grid:
        from matplotlib._svg_backend import _nice_ticks
        for t in _nice_ticks(xmin, xmax, 8):
            tx = sx(t)
            if plot_x < tx < plot_x + plot_w:
                draw.line([(tx, plot_y), (tx, plot_y + plot_h)], fill=(220, 220, 220))
        for t in _nice_ticks(ymin, ymax, 6):
            ty = sy(t)
            if plot_y < ty < plot_y + plot_h:
                draw.line([(plot_x, ty), (plot_x + plot_w, ty)], fill=(220, 220, 220))

    # Tick marks + labels
    from matplotlib._svg_backend import _nice_ticks, _fmt_tick
    for t in _nice_ticks(xmin, xmax, 8):
        tx = sx(t)
        if plot_x <= tx <= plot_x + plot_w:
            draw.line([(tx, plot_y + plot_h), (tx, plot_y + plot_h + 4)], fill=(0, 0, 0))
            draw.text((tx, plot_y + plot_h + 6), _fmt_tick(t), fill=(80, 80, 80), anchor="center")
    for t in _nice_ticks(ymin, ymax, 6):
        ty = sy(t)
        if plot_y <= ty <= plot_y + plot_h:
            draw.line([(plot_x - 4, ty), (plot_x, ty)], fill=(0, 0, 0))
            draw.text((plot_x - 6, ty - 6), _fmt_tick(t), fill=(80, 80, 80), anchor="right")

    # Data elements
    for elem in ax._elements:
        if elem['type'] == 'line':
            _draw_line(draw, elem, sx, sy)
        elif elem['type'] == 'scatter':
            _draw_scatter(draw, elem, sx, sy)
        elif elem['type'] == 'bar':
            _draw_bar(draw, elem, sx, sy, ymin)

    # Title
    if ax._title:
        draw.text((plot_x + plot_w // 2, plot_y - 24), ax._title, fill=(0, 0, 0), anchor="center")

    # Axis labels
    if ax._xlabel:
        draw.text((plot_x + plot_w // 2, img_h - 15), ax._xlabel, fill=(80, 80, 80), anchor="center")
    if ax._ylabel:
        draw.text((10, plot_y + plot_h // 2), ax._ylabel, fill=(80, 80, 80))


# ------------------------------------------------------------------
# Element renderers
# ------------------------------------------------------------------

def _draw_line(draw, elem, sx, sy):
    xd, yd = elem['x'], elem['y']
    if len(xd) < 2:
        return
    color = to_rgb(elem['color'])
    for i in range(len(xd) - 1):
        draw.line(
            [(sx(xd[i]), sy(yd[i])), (sx(xd[i + 1]), sy(yd[i + 1]))],
            fill=color, width=max(1, int(elem.get('linewidth', 1.5)))
        )

    marker = elem.get('marker')
    if marker:
        for i in range(len(xd)):
            cx, cy = sx(xd[i]), sy(yd[i])
            draw.ellipse([(cx - 3, cy - 3), (cx + 3, cy + 3)], fill=color)


def _draw_scatter(draw, elem, sx, sy):
    xd, yd = elem['x'], elem['y']
    color = to_rgb(elem['color'])
    s = elem.get('s', 20)
    import math
    r = max(1, int(math.sqrt(s) / 2))
    for i in range(len(xd)):
        cx, cy = sx(xd[i]), sy(yd[i])
        draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=color)


def _draw_bar(draw, elem, sx, sy, ymin):
    xd = elem['x']
    heights = elem['height']
    width = elem['width']
    color = to_rgb(elem['color'])

    for i in range(len(xd)):
        x_center = xd[i]
        h = heights[i]
        base_val = max(0, ymin)
        x_left = sx(x_center - width / 2)
        x_right = sx(x_center + width / 2)
        y_top = sy(h)
        y_bottom = sy(base_val)
        if y_bottom > y_top:
            draw.rectangle([(x_left, y_top), (x_right, y_bottom)], fill=color)


def _data_range(ax):
    """Same logic as SVG backend."""
    from matplotlib._svg_backend import _data_range
    return _data_range(ax)

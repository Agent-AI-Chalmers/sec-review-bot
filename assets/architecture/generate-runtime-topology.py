#!/usr/bin/env python3

from pathlib import Path
from xml.etree import ElementTree as ET


SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)

ROOT = Path(__file__).parent


def element(parent: ET.Element, tag: str, **attributes: object) -> ET.Element:
    return ET.SubElement(
        parent,
        f"{{{SVG}}}{tag}",
        {
            name.removesuffix("_").replace("_", "-"): str(value)
            for name, value in attributes.items()
        },
    )


def add_text(
    parent: ET.Element,
    x: int,
    y: int,
    value: str,
    *,
    css_class: str,
    text_anchor: str = "middle",
) -> None:
    lines = value.split("\n")
    text = element(parent, "text", x=x, y=y, class_=css_class, text_anchor=text_anchor)
    for index, line in enumerate(lines):
        span = element(text, "tspan", x=x, dy=0 if index == 0 else 18)
        span.text = line


def add_node(
    parent: ET.Element,
    node_id: str,
    x: int,
    y: int,
    width: int,
    height: int,
    label: str,
    tone: str,
) -> None:
    group = element(parent, "g", id=node_id, class_=f"node {tone}")
    element(group, "rect", x=x, y=y, width=width, height=height, rx=8, class_="node-surface")
    element(group, "path", d=f"M {x + 8} {y + 1} H {x + width - 8}", class_="node-accent")
    line_count = len(label.split("\n"))
    baseline = y + height // 2 - (line_count - 1) * 9 + 5
    add_text(group, x + width // 2, baseline, label, css_class="node-label")


def add_store(
    parent: ET.Element,
    node_id: str,
    x: int,
    y: int,
    width: int,
    height: int,
    label: str,
    tone: str,
    icon: str,
) -> None:
    group = element(parent, "g", id=node_id, class_=f"store {tone}")
    element(group, "rect", x=x, y=y, width=width, height=height, rx=8, class_="node-surface")
    element(group, "path", d=f"M {x + 8} {y + 1} H {x + width - 8}", class_="node-accent")
    icon_x = x + 34
    icon_y = y + height // 2 - 16
    if icon == "database":
        element(group, "ellipse", cx=icon_x, cy=icon_y + 6, rx=16, ry=5, class_="store-icon")
        element(group, "path", d=f"M {icon_x - 16} {icon_y + 6} V {icon_y + 27} M {icon_x + 16} {icon_y + 6} V {icon_y + 27} M {icon_x - 16} {icon_y + 27} C {icon_x - 16} {icon_y + 34}, {icon_x + 16} {icon_y + 34}, {icon_x + 16} {icon_y + 27}", class_="store-icon no-fill")
    elif icon == "objects":
        element(group, "rect", x=icon_x - 17, y=icon_y, width=14, height=14, rx=3, class_="object-icon")
        element(group, "rect", x=icon_x + 3, y=icon_y, width=14, height=14, rx=3, class_="object-icon")
        element(group, "rect", x=icon_x - 17, y=icon_y + 20, width=14, height=14, rx=3, class_="object-icon")
        element(group, "rect", x=icon_x + 3, y=icon_y + 20, width=14, height=14, rx=3, class_="object-icon")
    else:
        raise ValueError(f"Unknown store icon: {icon}")
    add_text(group, x + 128, y + height // 2 + 6, label, css_class="node-label")


def add_path(
    parent: ET.Element,
    points: list[tuple[int, int]],
    *,
    bidirectional: bool = False,
) -> None:
    commands = [f"M {points[0][0]} {points[0][1]}"]
    commands.extend(f"L {x} {y}" for x, y in points[1:])
    attributes: dict[str, object] = {
        "d": " ".join(commands),
        "class_": "edge",
        "marker_end": "url(#arrow)",
    }
    if bidirectional:
        attributes["marker_start"] = "url(#arrow)"
    element(parent, "path", **attributes)


def render(filename: str, labels: dict[str, str]) -> None:
    root = ET.Element(
        f"{{{SVG}}}svg",
        {
            "viewBox": "0 0 1400 680",
            "role": "img",
            "aria-labelledby": "title description",
        },
    )
    title = element(root, "title", id="title")
    title.text = labels["title"]
    description = element(root, "desc", id="description")
    description.text = labels["description"]

    defs = element(root, "defs")
    shadow = element(defs, "filter", id="shadow", x="-20%", y="-20%", width="140%", height="150%")
    element(shadow, "feDropShadow", dx=0, dy=3, stdDeviation=4, flood_color="#0f172a", flood_opacity=0.10)
    marker = element(
        defs,
        "marker",
        id="arrow",
        viewBox="0 0 10 10",
        refX=9,
        refY=5,
        markerWidth=5,
        markerHeight=5,
        markerUnits="userSpaceOnUse",
        orient="auto-start-reverse",
    )
    element(marker, "path", d="M 0 0 L 10 5 L 0 10 z", class_="arrow-head")
    style = element(defs, "style")
    style.text = """
      text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #263244; }
      .group { stroke-width: 1.25; }
      .external { fill: #f8fafc; stroke: #d8dee8; }
      .runtime { fill: #f8fbfa; stroke: #c7d8d2; }
      .persistence { fill: #fbfaf8; stroke: #ded8ce; }
      .group-label { font-size: 21px; font-weight: 650; fill: #475569; }
      .node, .store { filter: url(#shadow); }
      .node-surface { fill: #ffffff; stroke: #d6dce5; stroke-width: 1.25; }
      .node-accent { fill: none; stroke-width: 3; stroke-linecap: round; }
      .external-node .node-accent { stroke: #64748b; }
      .control-node .node-accent { stroke: #2878b5; }
      .execution-node .node-accent { stroke: #b85c38; }
      .memory-node .node-accent { stroke: #2f806a; }
      .storage-node .node-accent { stroke: #9a6a22; }
      .store-icon { fill: #f5f1e9; stroke: #8b6b3f; stroke-width: 1.4; }
      .store-icon.no-fill { fill: none; }
      .object-icon { fill: #f5f1e9; stroke: #8b6b3f; stroke-width: 1.4; }
      .node-label { font-size: 17px; font-weight: 550; }
      .edge { fill: none; stroke: #718096; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
      .arrow-head { fill: #718096; }
    """

    external = element(root, "g")
    element(external, "rect", x=20, y=24, width=200, height=360, rx=7, class_="group external")
    add_text(external, 120, 54, labels["external"], css_class="group-label")

    runtime = element(root, "g")
    element(runtime, "rect", x=250, y=24, width=1120, height=360, rx=7, class_="group runtime")
    add_text(runtime, 810, 54, labels["runtime"], css_class="group-label")

    persistence = element(root, "g")
    element(
        persistence,
        "rect",
        x=250,
        y=420,
        width=1120,
        height=230,
        rx=7,
        class_="group persistence",
    )

    add_node(root, "operator", 45, 94, 150, 72, labels["operator"], "external-node")
    add_node(root, "github", 45, 254, 150, 72, "GitHub", "external-node")
    add_node(root, "ui", 280, 94, 160, 72, "Control Plane UI", "control-node")
    add_node(root, "integration", 280, 254, 160, 72, "GitHub\nIntegration", "control-node")
    add_node(root, "control", 495, 94, 170, 72, "Review Control\nPlane", "control-node")
    add_node(root, "gateway", 710, 94, 160, 72, "Execution\nGateway", "execution-node")
    add_node(root, "temporal", 895, 94, 160, 72, "Temporal Server", "execution-node")
    add_node(root, "worker", 1080, 94, 160, 72, "Execution\nWorker", "execution-node")
    add_node(root, "catalog", 1080, 254, 160, 72, "Memory Catalog\nServer", "memory-node")

    add_store(root, "postgres", 500, 515, 210, 92, "PostgreSQL", "storage-node", "database")
    add_store(root, "storage", 970, 515, 210, 92, labels["storage"], "storage-node", "objects")

    add_path(root, [(195, 130), (280, 130)])
    add_path(root, [(195, 290), (280, 290)], bidirectional=True)
    add_path(root, [(440, 130), (495, 130)])
    add_path(root, [(440, 290), (470, 290), (470, 148), (495, 148)], bidirectional=True)
    add_path(root, [(665, 130), (710, 130)], bidirectional=True)
    add_path(root, [(870, 130), (895, 130)])
    add_path(root, [(1055, 130), (1080, 130)], bidirectional=True)
    add_path(root, [(1160, 166), (1160, 254)], bidirectional=True)

    add_path(root, [(580, 166), (580, 515)])
    add_path(root, [(1160, 326), (1160, 485), (655, 485), (655, 515)])
    add_path(root, [(360, 326), (360, 625), (930, 625), (930, 561), (970, 561)])
    add_path(root, [(790, 166), (790, 400), (950, 400), (950, 475), (1075, 475), (1075, 515)])
    add_path(root, [(1240, 130), (1310, 130), (1310, 561), (1180, 561)], bidirectional=True)

    add_text(root, 810, 454, labels["persistence"], css_class="group-label")

    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(ROOT / filename, encoding="utf-8", xml_declaration=True)


render(
    "runtime-topology.svg",
    {
        "title": "Sec Review Bot runtime topology",
        "description": "External systems connect to runtime services, with persistence infrastructure beneath the services.",
        "external": "External",
        "runtime": "Runtime services",
        "persistence": "Persistence infrastructure",
        "operator": "Operator\nbrowser",
        "storage": "Object Storage",
    },
)

render(
    "runtime-topology.zh.svg",
    {
        "title": "Sec Review Bot 运行拓扑",
        "description": "外部系统连接运行服务，持久化设施位于运行服务下方。",
        "external": "外部",
        "runtime": "运行服务",
        "persistence": "持久化设施",
        "operator": "运维人员\n浏览器",
        "storage": "对象存储",
    },
)

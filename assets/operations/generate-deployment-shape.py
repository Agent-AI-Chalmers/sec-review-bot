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
    element(
        group, "rect", x=x, y=y, width=width, height=height, rx=8, class_="node-surface"
    )
    element(
        group, "path", d=f"M {x + 8} {y + 1} H {x + width - 8}", class_="node-accent"
    )
    line_count = len(label.split("\n"))
    baseline = y + height // 2 - (line_count - 1) * 9 + 5
    add_text(group, x + width // 2, baseline, label, css_class="node-label")


def add_path(
    parent: ET.Element,
    points: list[tuple[int, int]],
    *,
    bidirectional: bool = False,
    dashed: bool = False,
) -> None:
    commands = rounded_path(points)
    classes = "edge dashed" if dashed else "edge"
    attributes: dict[str, object] = {
        "d": commands,
        "class_": classes,
        "marker_end": "url(#arrow)",
    }
    if bidirectional:
        attributes["marker_start"] = "url(#arrow)"
    element(parent, "path", **attributes)


def rounded_path(points: list[tuple[int, int]], radius: int = 10) -> str:
    commands = [f"M {points[0][0]} {points[0][1]}"]
    for index in range(1, len(points) - 1):
        previous = points[index - 1]
        current = points[index]
        following = points[index + 1]
        incoming = min(
            radius,
            abs(current[0] - previous[0]) // 2 + abs(current[1] - previous[1]) // 2,
        )
        outgoing = min(
            radius,
            abs(following[0] - current[0]) // 2 + abs(following[1] - current[1]) // 2,
        )
        before = (
            current[0] - (incoming if current[0] != previous[0] else 0),
            current[1] - (incoming if current[1] != previous[1] else 0),
        )
        after = (
            current[0] + (outgoing if following[0] != current[0] else 0),
            current[1] + (outgoing if following[1] != current[1] else 0),
        )
        commands.extend(
            (
                f"L {before[0]} {before[1]}",
                f"Q {current[0]} {current[1]} {after[0]} {after[1]}",
            )
        )
    commands.append(f"L {points[-1][0]} {points[-1][1]}")
    return " ".join(commands)


def render(filename: str, labels: dict[str, str]) -> None:
    root = ET.Element(
        f"{{{SVG}}}svg",
        {
            "viewBox": "0 0 1500 820",
            "role": "img",
            "aria-labelledby": "title description",
        },
    )
    title = element(root, "title", id="title")
    title.text = labels["title"]
    description = element(root, "desc", id="description")
    description.text = labels["description"]

    defs = element(root, "defs")
    shadow = element(
        defs, "filter", id="shadow", x="-20%", y="-20%", width="140%", height="150%"
    )
    element(
        shadow,
        "feDropShadow",
        dx=0,
        dy=3,
        stdDeviation=4,
        flood_color="#0f172a",
        flood_opacity=0.10,
    )
    marker = element(
        defs,
        "marker",
        id="arrow",
        viewBox="0 0 10 10",
        refX=9,
        refY=5,
        markerWidth=4,
        markerHeight=4,
        markerUnits="userSpaceOnUse",
        orient="auto-start-reverse",
    )
    element(marker, "path", d="M 0 0 L 10 5 L 0 10 z", class_="arrow-head")
    style = element(defs, "style")
    style.text = """
      text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #263244; }
      .zone { stroke-width: 1.25; }
      .external-zone { fill: #f8fafc; stroke: #d8dee8; }
      .compose-zone { fill: #f8fbfa; stroke: #c7d8d2; }
      .host-zone { fill: #fffaf6; stroke: #e2d3c6; }
      .zone-label { font-size: 21px; font-weight: 650; fill: #475569; paint-order: stroke; stroke: #ffffff; stroke-width: 10; stroke-linejoin: round; }
      .node { filter: url(#shadow); }
      .node-surface { fill: #ffffff; stroke: #d6dce5; stroke-width: 1.25; }
      .node-accent { fill: none; stroke-width: 3; stroke-linecap: round; }
      .external-node .node-accent { stroke: #64748b; }
      .control-node .node-accent { stroke: #2878b5; }
      .execution-node .node-accent { stroke: #b85c38; }
      .memory-node .node-accent { stroke: #2f806a; }
      .storage-node .node-accent { stroke: #9a6a22; }
      .sandbox-node .node-accent { stroke: #7c5c9e; }
      .node-label { font-size: 16px; font-weight: 550; }
      .edge { fill: none; stroke: #94a3b8; stroke-width: 1.15; stroke-linecap: round; stroke-linejoin: round; opacity: 0.76; }
      .edge.dashed { stroke-dasharray: 6 5; }
      .arrow-head { fill: #94a3b8; opacity: 0.76; }
    """

    element(
        root,
        "rect",
        x=20,
        y=24,
        width=220,
        height=760,
        rx=7,
        class_="zone external-zone",
    )
    add_text(root, 130, 56, labels["external"], css_class="zone-label")
    element(
        root,
        "rect",
        x=270,
        y=24,
        width=930,
        height=760,
        rx=7,
        class_="zone compose-zone",
    )
    add_text(root, 735, 56, "Docker Compose", css_class="zone-label")
    element(
        root, "rect", x=1230, y=24, width=240, height=760, rx=7, class_="zone host-zone"
    )
    add_text(root, 1350, 56, labels["host"], css_class="zone-label")

    add_path(root, [(210, 151), (300, 151)])
    add_path(root, [(470, 151), (510, 151)])
    add_path(root, [(680, 151), (720, 151)], bidirectional=True)
    add_path(root, [(900, 151), (940, 151)], bidirectional=True)
    add_path(root, [(1025, 187), (1025, 315)])
    add_path(
        root, [(1110, 333), (1180, 333), (1180, 301), (1260, 301)], bidirectional=True
    )
    add_path(
        root, [(1110, 351), (1190, 351), (1190, 426), (1260, 426)], bidirectional=True
    )
    add_path(
        root, [(1110, 369), (1200, 369), (1200, 551), (1260, 551)], bidirectional=True
    )
    add_path(root, [(1260, 283), (1245, 283), (1245, 691), (1260, 691)])
    add_path(root, [(210, 351), (300, 351)])
    add_path(root, [(470, 351), (490, 351), (490, 205), (720, 205), (720, 169)])
    add_path(root, [(680, 169), (700, 169), (700, 560), (975, 560), (975, 590)])
    add_path(root, [(810, 187), (810, 590)])
    add_path(root, [(600, 387), (600, 560), (740, 560), (740, 590)])
    add_path(root, [(1110, 169), (1140, 169), (1140, 560), (1070, 560), (1070, 590)])
    add_path(root, [(1025, 387), (1025, 590)], bidirectional=True)
    add_path(
        root, [(1260, 319), (1170, 319), (1170, 631), (1130, 631)], bidirectional=True
    )
    add_path(
        root, [(1260, 444), (1160, 444), (1160, 613), (1130, 613)], bidirectional=True
    )
    add_path(
        root, [(1260, 569), (1150, 569), (1150, 649), (1130, 649)], bidirectional=True
    )
    add_path(
        root,
        [(1260, 426), (1180, 426), (1180, 420), (710, 420), (710, 369), (690, 369)],
        bidirectional=True,
        dashed=True,
    )
    add_path(
        root,
        [(1260, 551), (1170, 551), (1170, 440), (730, 440), (730, 369), (690, 369)],
        bidirectional=True,
        dashed=True,
    )

    add_node(root, "github", 50, 115, 160, 72, "GitHub", "external-node")
    add_node(root, "browser", 50, 315, 160, 72, labels["browser"], "external-node")
    add_node(root, "tunnel", 300, 115, 170, 72, "Cloudflare\nTunnel", "control-node")
    add_node(
        root, "integration", 510, 115, 170, 72, "GitHub\nIntegration", "control-node"
    )
    add_node(
        root, "control", 720, 115, 180, 72, "Review Control\nPlane", "control-node"
    )
    add_node(root, "gateway", 940, 115, 170, 72, "Execution\nGateway", "execution-node")
    add_node(root, "ui", 300, 315, 170, 72, "Control Plane UI", "control-node")
    add_node(root, "temporal", 940, 315, 170, 72, "Temporal Server", "execution-node")
    add_node(
        root, "catalog", 510, 315, 180, 72, "Memory Catalog\nServer", "memory-node"
    )
    add_node(root, "postgres", 700, 590, 190, 82, "PostgreSQL", "storage-node")
    add_node(root, "storage", 940, 590, 190, 82, labels["storage"], "storage-node")
    add_node(
        root,
        "execution-worker",
        1250,
        265,
        200,
        72,
        "Execution Worker",
        "execution-node",
    )
    add_node(
        root,
        "memory-extraction-worker",
        1250,
        390,
        200,
        72,
        "Memory Extraction\nWorker",
        "memory-node",
    )
    add_node(
        root,
        "memory-maintenance-worker",
        1250,
        515,
        200,
        72,
        "Memory Maintenance\nWorker",
        "memory-node",
    )
    add_node(root, "sandbox", 1250, 650, 200, 82, "Docker sandbox", "sandbox-node")

    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    output = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    (ROOT / filename).write_bytes(output + b"\n")


render(
    "local-integrated-deployment.svg",
    {
        "title": "Local integrated deployment shape",
        "description": "GitHub and an operator browser connect to Docker Compose services, while three host worker pools execute reviews, memory extraction, and memory maintenance.",
        "external": "External",
        "host": "Host",
        "browser": "Operator\nbrowser",
        "storage": "Object Storage",
    },
)

render(
    "local-integrated-deployment.zh.svg",
    {
        "title": "本地集成部署结构",
        "description": "GitHub 和运维人员浏览器连接 Docker Compose 服务，宿主机上的三个 worker pool 分别执行 review、memory extraction 和 memory maintenance。",
        "external": "外部",
        "host": "宿主机",
        "browser": "运维人员\n浏览器",
        "storage": "对象存储",
    },
)

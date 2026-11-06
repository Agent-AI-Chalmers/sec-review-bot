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
            current[0]
            - (
                incoming
                if current[0] > previous[0]
                else -incoming if current[0] < previous[0] else 0
            ),
            current[1]
            - (
                incoming
                if current[1] > previous[1]
                else -incoming if current[1] < previous[1] else 0
            ),
        )
        after = (
            current[0]
            + (
                outgoing
                if following[0] > current[0]
                else -outgoing if following[0] < current[0] else 0
            ),
            current[1]
            + (
                outgoing
                if following[1] > current[1]
                else -outgoing if following[1] < current[1] else 0
            ),
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
            "viewBox": "0 0 1700 820",
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
    # Compose and native processes share one host, but separate lifecycles.
    element(
        root, "rect", x=270, y=24, width=1400, height=760, rx=7, class_="zone host-zone"
    )
    add_text(root, 970, 56, labels["host"], css_class="zone-label")
    element(
        root,
        "rect",
        x=470,
        y=85,
        width=930,
        height=650,
        rx=7,
        class_="zone compose-zone",
    )
    add_text(root, 935, 108, "Docker Compose", css_class="zone-label")

    element(root, "path", d="M 210 151 H 290", class_="edge", marker_end="url(#arrow)")
    element(root, "path", d="M 450 151 H 710", class_="edge", marker_end="url(#arrow)")
    add_path(root, [(880, 151), (920, 151)], bidirectional=True)
    add_path(root, [(1100, 151), (1140, 151)], bidirectional=True)
    add_path(root, [(1225, 187), (1225, 315)])
    add_path(
        root, [(1310, 333), (1380, 333), (1380, 301), (1460, 301)], bidirectional=True
    )
    add_path(
        root, [(1310, 351), (1390, 351), (1390, 426), (1460, 426)], bidirectional=True
    )
    add_path(
        root, [(1310, 369), (1400, 369), (1400, 551), (1460, 551)], bidirectional=True
    )
    add_path(root, [(1460, 283), (1445, 283), (1445, 691), (1460, 691)])
    add_path(root, [(210, 351), (500, 351)])
    add_path(root, [(670, 351), (690, 351), (690, 205), (920, 205), (920, 169)])
    add_path(root, [(880, 169), (900, 169), (900, 560), (1175, 560), (1175, 590)])
    add_path(root, [(1010, 187), (1010, 590)])
    add_path(root, [(800, 387), (800, 560), (940, 560), (940, 590)])
    add_path(
        root, [(1460, 319), (1370, 319), (1370, 631), (1330, 631)], bidirectional=True
    )
    add_path(
        root, [(1460, 444), (1360, 444), (1360, 613), (1330, 613)], bidirectional=True
    )
    add_path(
        root, [(1460, 569), (1350, 569), (1350, 649), (1330, 649)], bidirectional=True
    )
    add_path(
        root,
        [(1460, 426), (1380, 426), (1380, 420), (910, 420), (910, 369), (890, 369)],
        bidirectional=True,
        dashed=True,
    )
    add_path(
        root,
        [(1460, 551), (1370, 551), (1370, 440), (930, 440), (930, 369), (890, 369)],
        bidirectional=True,
        dashed=True,
    )

    # Catalog coordinates revisions; workers transfer artifact bytes directly.
    add_path(
        root,
        [(1450, 265), (1420, 265), (1420, 230), (800, 230), (800, 315)],
        dashed=True,
    )
    add_path(root, [(670, 351), (710, 351)])
    add_path(root, [(670, 375), (680, 375), (680, 710), (1235, 710), (1235, 672)])
    add_path(
        root,
        [(1010, 187), (1030, 215), (1330, 215), (1330, 580), (1290, 580), (1290, 590)],
    )

    # Optional telemetry goes to independently deployed Langfuse.
    add_path(
        root, [(1010, 115), (1010, 90), (250, 90), (250, 561), (210, 561)], dashed=True
    )
    for y in (301, 426, 551):
        add_path(
            root,
            [(1650, y), (1660, y), (1660, 755), (130, 755), (130, 607)],
            dashed=True,
        )

    add_node(root, "github", 50, 115, 160, 72, "GitHub", "external-node")
    add_node(root, "langfuse", 50, 515, 160, 92, labels["langfuse"], "external-node")
    add_node(root, "browser", 50, 315, 160, 72, labels["browser"], "external-node")
    add_node(
        root,
        "tunnel",
        290,
        115,
        160,
        72,
        "cloudflared\nCloudflare Tunnel",
        "control-node",
    )
    add_node(
        root, "integration", 710, 115, 170, 72, "GitHub\nIntegration", "control-node"
    )
    add_node(root, "review-runs", 920, 115, 180, 72, "Review Runs", "control-node")
    add_node(
        root, "gateway", 1140, 115, 170, 72, "Execution\nGateway", "execution-node"
    )
    add_node(root, "ui", 500, 315, 170, 72, "Control Plane UI", "control-node")
    add_node(root, "temporal", 1140, 315, 170, 72, "Temporal Server", "execution-node")
    add_node(
        root, "catalog", 710, 315, 180, 72, "Memory Catalog\nServer", "memory-node"
    )
    add_node(root, "postgres", 900, 590, 190, 82, "PostgreSQL", "storage-node")
    add_node(root, "storage", 1140, 590, 190, 82, labels["storage"], "storage-node")
    add_node(
        root,
        "execution-worker",
        1450,
        265,
        200,
        72,
        "Execution Worker",
        "execution-node",
    )
    add_node(
        root,
        "memory-extraction-worker",
        1450,
        390,
        200,
        72,
        "Memory Extraction\nWorker",
        "memory-node",
    )
    add_node(
        root,
        "memory-maintenance-worker",
        1450,
        515,
        200,
        72,
        "Memory Maintenance\nWorker",
        "memory-node",
    )
    add_node(root, "sandbox", 1450, 650, 200, 82, "Docker sandbox", "sandbox-node")

    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    output = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    (ROOT / filename).write_bytes(output + b"\n")


render(
    "local-integrated-deployment.svg",
    {
        "title": "Local integrated deployment shape",
        "description": "GitHub, an operator browser, and independently deployed Langfuse connect to Docker Compose services and host workers. Catalog coordinates memory revisions; workers transfer artifacts directly to object storage.",
        "external": "External",
        "host": "Host",
        "browser": "Operator\nbrowser",
        "storage": "RustFS\nObject Storage",
        "langfuse": "Langfuse\nObservability",
    },
)

render(
    "local-integrated-deployment.zh.svg",
    {
        "title": "本地集成部署结构",
        "description": "GitHub、运维人员浏览器和独立部署的 Langfuse 连接 Compose 服务及宿主机 workers。Catalog 协调 Memory revision，workers 直接向对象存储传输 artifacts。",
        "external": "外部",
        "host": "宿主机",
        "browser": "运维人员\n浏览器",
        "storage": "RustFS\n对象存储",
        "langfuse": "Langfuse\n可观测性",
    },
)

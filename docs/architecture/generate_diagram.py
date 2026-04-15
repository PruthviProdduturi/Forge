"""
Forge Platform — Network Architecture Diagram
Generates docs/architecture/network-diagram.png
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.patheffects as pe

fig, ax = plt.subplots(figsize=(24, 16))
fig.patch.set_facecolor('#0d1117')
ax.set_facecolor('#0d1117')
ax.set_xlim(0, 24)
ax.set_ylim(0, 16)
ax.axis('off')

# ── palette ──────────────────────────────────────────────────────────────────
C = {
    'azure_blue':   '#0078d4',
    'azure_dark':   '#005a9e',
    'vnet':         '#1a3a5c',
    'vnet_border':  '#0078d4',
    'compute_sub':  '#0f2d1a',
    'orch_sub':     '#1a1f0f',
    'pe_sub':       '#1a0f2d',
    'pg_sub':       '#2d1a0f',
    'node_bg':      '#1e3a52',
    'pod_bg':       '#162a3a',
    'svc_bg':       '#1a2a1a',
    'pe_bg':        '#1e1a2d',
    'internet':     '#1c2a1c',
    'azure_svc':    '#1a1a2d',
    'text':         '#e6edf3',
    'subtext':      '#8b949e',
    'green':        '#3fb950',
    'orange':       '#d29922',
    'purple':       '#bc8cff',
    'red':          '#f85149',
    'teal':         '#39c5cf',
    'yellow':       '#e3b341',
    'pink':         '#ff7b72',
    'white':        '#ffffff',
    'arrow':        '#58a6ff',
    'arrow_dim':    '#30363d',
}

def box(x, y, w, h, color, alpha=1.0, radius=0.2, lw=1.5, edge=None):
    ec = edge or color
    r = FancyBboxPatch((x, y), w, h,
                       boxstyle=f'round,pad=0,rounding_size={radius}',
                       facecolor=color, edgecolor=ec,
                       linewidth=lw, alpha=alpha, zorder=2)
    ax.add_patch(r)
    return r

def label(x, y, text, size=8, color='#e6edf3', bold=False, ha='center', va='center', zorder=5):
    weight = 'bold' if bold else 'normal'
    ax.text(x, y, text, fontsize=size, color=color, ha=ha, va=va,
            fontweight=weight, zorder=zorder,
            fontfamily='monospace')

def section_title(x, y, text, color, size=7.5):
    ax.text(x, y, text, fontsize=size, color=color, ha='left', va='top',
            fontweight='bold', zorder=6, fontfamily='monospace',
            alpha=0.85)

def arrow(x1, y1, x2, y2, color='#58a6ff', lw=1.2, style='->', ls='-'):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color,
                                lw=lw, linestyle=ls),
                zorder=4)

def dot_circle(cx, cy, r=0.13, color='#58a6ff'):
    c = plt.Circle((cx, cy), r, color=color, zorder=5)
    ax.add_patch(c)

# ── Title ─────────────────────────────────────────────────────────────────────
label(12, 15.6, 'Forge Platform — Network Architecture', size=15, bold=True, color=C['white'])
label(12, 15.25, 'Azure  ·  westcentralus  ·  VNet 10.0.0.0/16  ·  AKS Azure CNI Overlay', size=8.5, color=C['subtext'])

# ═══════════════════════════════════════════════════════════════════════════════
# INTERNET / USER  (top-left)
# ═══════════════════════════════════════════════════════════════════════════════
box(0.3, 13.5, 2.8, 1.2, C['internet'], edge='#3fb950', lw=1.5)
label(1.7, 14.35, 'INTERNET / USERS', size=8, bold=True, color=C['green'])
label(1.7, 14.0, 'Browser / Spark Connect', size=7, color=C['subtext'])
label(1.7, 13.7, 'SDK / Trino Client', size=7, color=C['subtext'])

# Public IPs
box(0.3, 11.8, 2.8, 1.5, '#0d1f0d', edge=C['green'], lw=1.2)
section_title(0.5, 13.2, 'PUBLIC IPs', C['green'], 7)
label(1.7, 12.85, 'pip-forge-orch-dev', size=7, color=C['teal'])
label(1.7, 12.6,  '(Portal / Airflow)', size=6.5, color=C['subtext'])
label(1.7, 12.3,  'pip-forge-compute-dev', size=7, color=C['teal'])
label(1.7, 12.05, '(Spark Connect / Trino)', size=6.5, color=C['subtext'])

# Load Balancers
box(0.3, 10.1, 2.8, 1.5, '#0d1a2d', edge=C['azure_blue'], lw=1.2)
section_title(0.5, 11.5, 'LOAD BALANCERS', C['azure_blue'], 7)
label(1.7, 11.15, 'lb-forge-orch-dev', size=7, color=C['yellow'])
label(1.7, 10.9,  'nginx-ingress  :443/:80', size=6.5, color=C['subtext'])
label(1.7, 10.6,  'lb-forge-compute-dev', size=7, color=C['yellow'])
label(1.7, 10.35, 'ports 15002 / 8080', size=6.5, color=C['subtext'])

# arrows: internet → public IPs → LBs
arrow(1.7, 13.5, 1.7, 13.3, color=C['green'])
arrow(1.7, 11.8, 1.7, 11.6, color=C['azure_blue'])

# ═══════════════════════════════════════════════════════════════════════════════
# VNet outer box
# ═══════════════════════════════════════════════════════════════════════════════
box(3.4, 0.4, 20.2, 14.3, C['vnet'], edge=C['vnet_border'], lw=2, radius=0.35, alpha=0.6)
section_title(3.6, 14.6, f'  VNet  vnet-forge-prproddu-dev   10.0.0.0/16', C['azure_blue'], 8.5)

# LB arrows into VNet
arrow(3.1, 11.0, 3.4, 11.0, color=C['yellow'], lw=1.5)

# ═══════════════════════════════════════════════════════════════════════════════
# COMPUTE SUBNET  10.0.0.0/22
# ═══════════════════════════════════════════════════════════════════════════════
box(3.6, 7.6, 9.6, 6.5, C['compute_sub'], edge=C['green'], lw=1.5, radius=0.25)
section_title(3.8, 14.0, 'snet-forge-compute-prproddu-dev   10.0.0.0/22', C['green'], 7.5)

# --- Compute AKS Node Pool ---
box(3.8, 10.8, 4.4, 3.1, C['node_bg'], edge=C['teal'], lw=1.2, radius=0.2)
section_title(4.0, 13.8, 'AKS Node (compute)', C['teal'], 7)
label(6.0, 13.45, 'aks-forge-compute-prproddu-dev', size=6.5, color=C['subtext'])

# NIC
box(4.0, 12.9, 3.8, 0.55, '#0e2233', edge=C['teal'], lw=0.8, radius=0.12)
dot_circle(4.25, 13.17, 0.1, C['teal'])
label(6.1, 13.17, 'NIC  nic-compute-node-0   10.0.0.4', size=6.5, color=C['teal'])

# Pods
box(4.0, 10.95, 1.7, 1.75, C['pod_bg'], edge='#39c5cf', lw=0.7, radius=0.12)
label(4.85, 12.4, 'Spark Driver', size=6.5, bold=True, color=C['white'])
label(4.85, 12.1, 'Pod IP: 10.100.x.x', size=6, color=C['subtext'])
label(4.85, 11.85, ':15002 (Connect)', size=6, color=C['orange'])
label(4.85, 11.6, ':4040 (UI)', size=6, color=C['subtext'])
label(4.85, 11.3, 'Spark Executor', size=6.5, bold=True, color=C['white'])

box(5.85, 10.95, 1.8, 1.75, C['pod_bg'], edge='#bc8cff', lw=0.7, radius=0.12)
label(6.75, 12.4, 'Trino', size=6.5, bold=True, color=C['white'])
label(6.75, 12.1, 'Coordinator', size=6, color=C['subtext'])
label(6.75, 11.85, ':8080 (HTTP)', size=6, color=C['orange'])
label(6.75, 11.6, ':8443 (HTTPS)', size=6, color=C['subtext'])
label(6.75, 11.3, '+ Workers', size=6, color=C['subtext'])

# Trino auth proxy (compute)
box(3.8, 7.75, 4.4, 0.85, '#1a0d2d', edge=C['purple'], lw=0.8, radius=0.12)
label(6.0, 8.4, 'Trino Auth Proxy', size=7, bold=True, color=C['purple'])
label(6.0, 8.1, 'IMDS MI token → Trino OAuth   :8090', size=6.5, color=C['subtext'])

# --- Compute route table note ---
label(6.0, 10.6, 'rt-forge-compute-prproddu-dev', size=6, color=C['subtext'])
label(6.0, 10.4, 'NSG: nsg-forge-compute-prproddu-dev', size=6, color=C['subtext'])

# pod CIDR note
box(8.4, 10.8, 4.6, 3.1, C['node_bg'], edge='#555', lw=0.8, radius=0.15, alpha=0.5)
section_title(8.6, 13.8, 'Pod CIDR (Azure CNI Overlay)', '#555', 7)
label(10.7, 13.35, '10.100.0.0/16  (compute)', size=7, color=C['subtext'])
label(10.7, 13.05, 'Pods get IPs outside VNet', size=6.5, color=C['subtext'])
label(10.7, 12.75, 'Routed via VNet dataplane', size=6.5, color=C['subtext'])
label(10.7, 12.4, '10.101.0.0/16 (orch)', size=7, color=C['subtext'])
label(10.7, 12.1, 'Pods get IPs outside VNet', size=6.5, color=C['subtext'])
label(10.7, 11.5, 'Svc CIDR: 10.200.0.0/16', size=7, color=C['orange'])
label(10.7, 11.2, 'ClusterIP (orch)', size=6.5, color=C['subtext'])
label(10.7, 10.9, 'Svc CIDR: 10.201.0.0/16', size=7, color=C['orange'])
label(10.7, 10.6, 'ClusterIP (compute)', size=6.5, color=C['subtext'])

# ═══════════════════════════════════════════════════════════════════════════════
# ORCHESTRATION SUBNET  10.0.4.0/22
# ═══════════════════════════════════════════════════════════════════════════════
box(13.4, 7.6, 9.8, 6.5, C['orch_sub'], edge=C['orange'], lw=1.5, radius=0.25)
section_title(13.6, 14.0, 'snet-forge-orchestration-prproddu-dev   10.0.4.0/22', C['orange'], 7.5)

# AKS Orch Node
box(13.6, 10.8, 9.3, 3.1, C['node_bg'], edge=C['yellow'], lw=1.2, radius=0.2)
section_title(13.8, 13.8, 'AKS Node (orchestration)', C['yellow'], 7)
label(18.25, 13.45, 'aks-forge-orch-prproddu-dev', size=6.5, color=C['subtext'])

# NIC
box(13.8, 12.9, 8.8, 0.55, '#0e2233', edge=C['yellow'], lw=0.8, radius=0.12)
dot_circle(14.05, 13.17, 0.1, C['yellow'])
label(18.2, 13.17, 'NIC  nic-orch-node-0   10.0.4.4', size=6.5, color=C['yellow'])

# Pods row
pod_specs = [
    ('Airflow\nScheduler\n+ Workers', ':8080', C['orange'], 13.8),
    ('Portal\nAPI + Web\n:8000/:3000', ':443', C['azure_blue'], 15.65),
    ('Grafana\n:3000', ':3000', '#e05c00', 17.3),
    ('Hive\nMetastore\n:9083', ':9083', C['purple'], 18.9),
]
for name, port, clr, px in pod_specs:
    box(px, 10.95, 1.65, 1.8, C['pod_bg'], edge=clr, lw=0.7, radius=0.12)
    lines = name.split('\n')
    for i, ln in enumerate(lines):
        label(px+0.825, 12.55 - i*0.28, ln, size=6.5 if i==0 else 6,
              bold=(i==0), color=C['white'] if i==0 else C['subtext'])
    label(px+0.825, 11.1, port, size=6, color=C['orange'])

# Auth Proxy
box(13.6, 9.65, 9.3, 0.95, '#1a0d2d', edge='#bc8cff', lw=0.8, radius=0.12)
label(18.25, 10.3, 'Portal Auth Proxy', size=7, bold=True, color=C['purple'])
label(18.25, 9.95, 'IMDS MI token → AAD  ·  :8888', size=6.5, color=C['subtext'])

label(18.25, 10.6, 'rt-forge-orchestration  ·  NSG: nsg-forge-orchestration-prproddu-dev', size=6, color=C['subtext'])

# ingress-nginx
box(13.6, 7.75, 9.3, 1.65, '#0d1f0d', edge=C['green'], lw=0.8, radius=0.12)
label(18.25, 9.2, 'ingress-nginx (cert-manager + Let\'s Encrypt)', size=7, bold=True, color=C['green'])
label(18.25, 8.85, 'forge-portal-dev.westcentralus.cloudapp.azure.com  :443/:80', size=6.5, color=C['teal'])
label(18.25, 8.55, '→  /api/v1/*  portal-api   →  /*  portal-web', size=6.5, color=C['subtext'])
label(18.25, 8.25, 'forge-compute-prproddudev.westcentralus.cloudapp.azure.com', size=6.5, color=C['teal'])
label(18.25, 7.95, '→  :15002 Spark Connect   →  :8080 Trino HTTP', size=6.5, color=C['subtext'])

# ═══════════════════════════════════════════════════════════════════════════════
# PRIVATE ENDPOINTS SUBNET  10.0.8.0/24
# ═══════════════════════════════════════════════════════════════════════════════
box(3.6, 3.9, 9.6, 3.4, C['pe_sub'], edge=C['purple'], lw=1.5, radius=0.25)
section_title(3.8, 7.2, 'snet-forge-private-endpoints-prproddu-dev   10.0.8.0/24', C['purple'], 7.5)

pe_items = [
    ('pe-acr',     'ACR',        '10.0.8.4',  C['azure_blue'], 0),
    ('pe-kv',      'Key Vault',  '10.0.8.5',  C['yellow'],     1),
    ('pe-adls',    'ADLS Gen2',  '10.0.8.6',  C['teal'],       2),
    ('pe-postgres', 'Postgres',  '10.0.8.7',  C['orange'],     3),
]
for name, svc, ip, clr, idx in pe_items:
    px = 3.8 + idx * 2.3
    box(px, 4.1, 2.0, 2.95, C['pe_bg'], edge=clr, lw=0.8, radius=0.15)
    label(px+1.0, 6.75, name, size=7, bold=True, color=clr)
    label(px+1.0, 6.45, f'→ {svc}', size=6.5, color=C['white'])
    label(px+1.0, 6.15, ip, size=6.5, color=C['subtext'])
    # NIC inside PE
    box(px+0.1, 4.2, 1.8, 0.65, '#120d1f', edge=clr, lw=0.5, radius=0.1)
    dot_circle(px+0.3, 4.52, 0.08, clr)
    label(px+1.0, 4.52, f'NIC {ip}/28', size=6, color=clr)
    # DNS note
    label(px+1.0, 5.85, 'Private DNS', size=6, color=C['subtext'])
    label(px+1.0, 5.58, '*.privatelink.*', size=6, color=C['subtext'])
    label(px+1.0, 5.3, 'azure.com', size=6, color=C['subtext'])
    # NSG note
    label(px+1.0, 4.98, 'NSG: nsg-forge', size=6, color='#444')
    label(px+1.0, 4.72, 'private-endpoints', size=6, color='#444')

section_title(3.8, 4.05, 'NSG: nsg-forge-private-endpoints-prproddu-dev', '#666', 6.5)

# ═══════════════════════════════════════════════════════════════════════════════
# POSTGRES SUBNET  10.0.9.0/24
# ═══════════════════════════════════════════════════════════════════════════════
box(13.4, 3.9, 9.8, 3.4, C['pg_sub'], edge=C['orange'], lw=1.5, radius=0.25)
section_title(13.6, 7.2, 'snet-forge-postgres-prproddu-dev   10.0.9.0/24', C['orange'], 7.5)

box(13.6, 4.1, 9.3, 2.95, '#1f1008', edge=C['orange'], lw=0.8, radius=0.15)
label(18.25, 6.75, 'forge-pg-prproddu-dev', size=8, bold=True, color=C['orange'])
label(18.25, 6.4, 'Azure Database for PostgreSQL Flexible Server', size=7, color=C['subtext'])
label(18.25, 6.1, '10.0.9.4   port 5432', size=7, color=C['teal'])
# NIC
box(13.8, 4.2, 8.8, 0.65, '#120a00', edge=C['orange'], lw=0.5, radius=0.1)
dot_circle(14.05, 4.52, 0.1, C['orange'])
label(18.25, 4.52, 'NIC  nic-forge-pg-prproddu-dev   10.0.9.4', size=6.5, color=C['orange'])
label(18.25, 5.75, 'VNet injection (no public endpoint)  ·  NSG: nsg-forge-postgres-prproddu-dev', size=6.5, color=C['subtext'])
label(18.25, 5.45, 'DB: airflow  ·  DB: portal  ·  DB: hive', size=7, color=C['white'])
label(18.25, 5.15, 'MI auth (workload identity)  ·  no password auth', size=6.5, color=C['green'])

# ═══════════════════════════════════════════════════════════════════════════════
# AZURE SERVICES panel  (bottom of VNet)
# ═══════════════════════════════════════════════════════════════════════════════
box(3.6, 0.5, 19.9, 3.2, C['azure_svc'], edge='#30363d', lw=1.2, radius=0.2)
section_title(3.8, 3.6, 'Azure PaaS / Managed Services  (accessed via Private Endpoints)', '#58a6ff', 7.5)

svc_items = [
    ('forgeacr{alias}',       'ACR Premium',    'image pull / push',           C['azure_blue']),
    ('forge-kv-prproddu-dev', 'Key Vault',       'secrets, certs, MI tokens',   C['yellow']),
    ('forgeadlsprproddudev',  'ADLS Gen2',       'bronze/silver/gold',          C['teal']),
    ('forge-pg-prproddu-dev', 'PostgreSQL FS',   'airflow / portal / hive DBs', C['orange']),
    ('Law + Diag',            'Azure Monitor',   'NSG flow logs, metrics',      C['pink']),
    ('AAD / Entra ID',        'App Roles',       'MSAL OAuth2 / OIDC',          C['purple']),
]
for i, (name, kind, desc, clr) in enumerate(svc_items):
    px = 3.8 + i * 3.25
    box(px, 0.65, 3.0, 2.65, '#0d1117', edge=clr, lw=0.8, radius=0.15)
    label(px+1.5, 3.0, kind, size=7.5, bold=True, color=clr)
    label(px+1.5, 2.7, name, size=6.5, color=C['white'])
    label(px+1.5, 2.4, desc, size=6, color=C['subtext'])

# ═══════════════════════════════════════════════════════════════════════════════
# ARROWS  (key flows)
# ═══════════════════════════════════════════════════════════════════════════════
# Internet → LBs → VNet
arrow(1.7, 13.5, 1.7, 13.32, color=C['green'], lw=1.5)
arrow(1.7, 11.8, 1.7, 11.62, color=C['azure_blue'], lw=1.5)
arrow(3.1, 11.0, 3.55, 11.0, color=C['yellow'], lw=2.0)  # LB → compute subnet
arrow(3.1, 11.0, 13.4, 9.2, color=C['yellow'], lw=1.5, ls='--')  # LB → orch subnet

# Pods → private endpoints
arrow(6.0, 10.8, 6.0, 7.2, color=C['purple'], lw=1.0, ls='--')
arrow(18.25, 7.6, 10.0, 7.2, color=C['purple'], lw=1.0, ls='--')

# PE → Azure services
arrow(7.6, 3.9, 7.6, 3.25, color=C['purple'], lw=1.0, ls='--')

# Postgres subnet → PE (cross link)
arrow(13.4, 5.5, 13.2, 5.5, color=C['arrow_dim'], lw=0.7, ls=':')

# identity labels (workload identity flow note)
box(3.6, 1.5, 0.0, 0.0, '#000', edge='#000', lw=0)   # placeholder
ax.text(0.3, 3.0, 'Workload Identity', fontsize=7, color=C['subtext'],
        rotation=90, va='center', ha='center', fontfamily='monospace')
ax.text(0.3, 1.5, 'id-forge-{spark,trino,airflow,\ndq,portal,hms}-prproddu-dev',
        fontsize=5.5, color=C['subtext'], va='center', ha='center',
        fontfamily='monospace')

# ── Legend ────────────────────────────────────────────────────────────────────
legend_items = [
    (C['green'],  'Compute subnet / Public IPs / LB (compute)'),
    (C['orange'], 'Orchestration subnet / LB (orch) / Postgres'),
    (C['purple'], 'Private Endpoints subnet / Workload Identities'),
    (C['teal'],   'NICs / ADLS / Spark Connect'),
    (C['yellow'], 'Load Balancers / Key Vault / Orch nodes'),
    (C['pink'],   'Azure Monitor / Diagnostics'),
]
lx, ly = 23.7, 15.0
for i, (clr, lbl) in enumerate(legend_items):
    dot_circle(lx, ly - i*0.32, 0.07, clr)
    ax.text(lx+0.15, ly - i*0.32, lbl, fontsize=5.5, color=C['subtext'],
            va='center', fontfamily='monospace')

ax.text(lx-0.1, 13.0, 'Legend', fontsize=6.5, color=C['subtext'],
        fontweight='bold', fontfamily='monospace')

# ── Footer ────────────────────────────────────────────────────────────────────
ax.text(12, 0.18, 'Forge Platform · rg-forge-prproddu-dev · AKS Azure CNI Overlay · All services via Private Endpoints · No public DB/storage endpoints',
        fontsize=6, color='#444', ha='center', fontfamily='monospace')

plt.tight_layout(pad=0.3)
out = 'docs/architecture/network-diagram.png'
plt.savefig(out, dpi=160, bbox_inches='tight', facecolor=fig.get_facecolor())
print(f'Saved: {out}')

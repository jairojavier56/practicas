#!/usr/bin/env python3
"""Genera lab.json y configs/ del lab MPLS L3VPN (Cisco IOL + Juniper vJunos + FRR).
Edita las tablas de arriba (nodos, enlaces, VRFs) y vuelve a ejecutar:  python3 generate.py"""
import json, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
ASN = 65000
LO = {"p1": "10.255.0.1", "p2": "10.255.0.2", "pe1": "10.255.0.11", "pe2": "10.255.0.12", "pe3": "10.255.0.13", "rr1": "10.255.0.100"}
KINDS = {"p1": "cisco-iol", "p2": "cisco-iol", "pe2": "cisco-iol", "pe3": "cisco-iol", "rr1": "cisco-iol", "upstream": "cisco-iol",
         "pe1": "vjunos-router", "ce-a1": "frr", "ce-a2": "frr", "ce-b1": "frr", "ce-b2": "frr"}
# (id, nodoA, ifA, ipA, nodoB, ifB, ipB)  — todas /30
L = [
    ("p1-p2", "p1", "Ethernet0/1", "10.1.1.1", "p2", "Ethernet0/1", "10.1.1.2"),
    ("pe1-p1", "pe1", "ge-0/0/0", "10.1.2.1", "p1", "Ethernet0/2", "10.1.2.2"),
    ("pe1-p2", "pe1", "ge-0/0/1", "10.1.3.1", "p2", "Ethernet0/2", "10.1.3.2"),
    ("pe2-p1", "pe2", "Ethernet0/1", "10.1.4.1", "p1", "Ethernet0/3", "10.1.4.2"),
    ("pe3-p2", "pe3", "Ethernet0/1", "10.1.5.1", "p2", "Ethernet0/3", "10.1.5.2"),
    ("pe2-pe3", "pe2", "Ethernet0/2", "10.1.6.1", "pe3", "Ethernet0/2", "10.1.6.2"),
    ("rr1-p1", "rr1", "Ethernet0/1", "10.1.7.1", "p1", "Ethernet1/0", "10.1.7.2"),
    ("ce-a1", "pe1", "ge-0/0/2", "172.16.1.1", "ce-a1", "eth1", "172.16.1.2"),
    ("ce-a2", "pe2", "Ethernet0/3", "172.16.2.1", "ce-a2", "eth1", "172.16.2.2"),
    ("ce-b1", "pe2", "Ethernet1/0", "172.17.1.1", "ce-b1", "eth1", "172.17.1.2"),
    ("ce-b2", "pe3", "Ethernet0/3", "172.17.2.1", "ce-b2", "eth1", "172.17.2.2"),
    ("upstream", "pe3", "Ethernet1/0", "192.0.2.1", "upstream", "Ethernet0/1", "192.0.2.2"),
]
CORE = {"p1-p2", "pe1-p1", "pe1-p2", "pe2-p1", "pe3-p2", "pe2-pe3", "rr1-p1"}   # IS-IS
NO_LDP = {"rr1-p1"}                                                            # el RR no va en el camino de datos
VRF = {"pe1": {"ge-0/0/2": "CUST-A"}, "pe2": {"Ethernet0/3": "CUST-A", "Ethernet1/0": "CUST-B"}, "pe3": {"Ethernet0/3": "CUST-B"}}
CE_AS = {"172.16.1.2": 65501, "172.16.2.2": 65502, "172.17.1.2": 65511, "172.17.2.2": 65512}
RT = {"CUST-A": 100, "CUST-B": 200}
PES = ("pe1", "pe2", "pe3")
CES = {"ce-a1": ("172.16.1.2", "172.16.1.1", 65501, "192.168.10.0/24"), "ce-a2": ("172.16.2.2", "172.16.2.1", 65502, "192.168.20.0/24"),
       "ce-b1": ("172.17.1.2", "172.17.1.1", 65511, "192.168.10.0/24"), "ce-b2": ("172.17.2.2", "172.17.2.1", 65512, "192.168.30.0/24")}

def net(lo):  # 10.255.0.11 → 49.0001.0102.5500.0011.00
    d = "".join(f"{int(x):03d}" for x in lo.split("."))
    return f"49.0001.{d[0:4]}.{d[4:8]}.{d[8:12]}.00"

def ifs_of(n):
    for l in L:
        if l[1] == n: yield (l[0], l[2], l[3], l[4], l[6])
        if l[4] == n: yield (l[0], l[5], l[6], l[1], l[3])

def ios(n):
    c = [f"! ===== {n} (Cisco IOL, AS{ASN}) — generado por generate.py =====", f"hostname {n}", "ip bgp-community new-format"]
    for v in sorted(set(VRF.get(n, {}).values())):
        c += [f"vrf definition {v}", f" rd {ASN}:{RT[v]}{LO[n].split('.')[-1]}", " address-family ipv4",
              f"  route-target export {ASN}:{RT[v]}", f"  route-target import {ASN}:{RT[v]}", " exit-address-family"]
    c += ["interface Loopback0", f" ip address {LO[n]} 255.255.255.255", " ip router isis CORE"]
    for lid, ifn, ip, peer, _ in ifs_of(n):
        c += [f"interface {ifn}", f" description -> {peer}"]
        if ifn in VRF.get(n, {}): c.append(f" vrf forwarding {VRF[n][ifn]}")
        c.append(f" ip address {ip} 255.255.255.252")
        if lid in CORE:
            c += [" ip router isis CORE", " isis network point-to-point"]
            if lid not in NO_LDP: c.append(" mpls ip")
        c.append(" no shutdown")
    c += ["router isis CORE", f" net {net(LO[n])}", " is-type level-2-only", " metric-style wide", " passive-interface Loopback0"]
    if n != "rr1": c += ["mpls label protocol ldp", "mpls ldp router-id Loopback0 force"]
    if n == "rr1":
        c += [f"router bgp {ASN}", f" bgp router-id {LO[n]}", " bgp log-neighbor-changes", " no bgp default ipv4-unicast",
              f" bgp cluster-id {LO[n]}", " neighbor PES peer-group", f" neighbor PES remote-as {ASN}", " neighbor PES update-source Loopback0"]
        c += [f" neighbor {LO[p]} peer-group PES" for p in PES]
        for af, comm in (("ipv4", "both"), ("vpnv4", "extended")):
            c += [f" address-family {af}", "  neighbor PES activate", "  neighbor PES route-reflector-client", f"  neighbor PES send-community {comm}"]
            c += [f"  neighbor {LO[p]} activate" for p in PES]
            c.append(" exit-address-family")
    elif n in PES:
        rr = LO["rr1"]
        c += [f"router bgp {ASN}", f" bgp router-id {LO[n]}", " bgp log-neighbor-changes", " no bgp default ipv4-unicast",
              f" neighbor {rr} remote-as {ASN}", f" neighbor {rr} update-source Loopback0"]
        if n == "pe3": c.append(" neighbor 192.0.2.2 remote-as 65100")
        c += [" address-family ipv4", f"  neighbor {rr} activate", f"  neighbor {rr} next-hop-self", f"  neighbor {rr} send-community both"]
        if n == "pe3":
            c += ["  neighbor 192.0.2.2 activate", "  neighbor 192.0.2.2 route-map UPSTREAM-IN in", "  neighbor 192.0.2.2 route-map UPSTREAM-OUT out",
                  "  network 198.51.100.0 mask 255.255.255.0"]
        c += [" exit-address-family", " address-family vpnv4", f"  neighbor {rr} activate", f"  neighbor {rr} send-community extended", " exit-address-family"]
        for ifn, v in VRF.get(n, {}).items():
            ceip = next(x[4] for x in ifs_of(n) if x[1] == ifn)
            c += [f" address-family ipv4 vrf {v}", f"  neighbor {ceip} remote-as {CE_AS[ceip]}", f"  neighbor {ceip} activate", " exit-address-family"]
        if n == "pe3":
            c += ["ip route 198.51.100.0 255.255.255.0 Null0",
                  "! Entrada del tránsito: prefiere y marca sus rutas", "route-map UPSTREAM-IN permit 10", " set local-preference 120", f" set community {ASN}:100",
                  "! Salida al tránsito: SOLO el agregado del ISP", "ip prefix-list ISP-AGG seq 10 permit 198.51.100.0/24",
                  "route-map UPSTREAM-OUT permit 10", " match ip address prefix-list ISP-AGG"]
    c.append("end")
    return "\n".join(c) + "\n"

def junos(n):
    c = [f"# ===== {n} (Juniper vJunos-router, AS{ASN}) — generado por generate.py ====="]
    for lid, ifn, ip, peer, _ in ifs_of(n):
        c += [f'set interfaces {ifn} description "-> {peer}"', f"set interfaces {ifn} unit 0 family inet address {ip}/30"]
        if lid in CORE: c += [f"set interfaces {ifn} unit 0 family iso", f"set interfaces {ifn} unit 0 family mpls"]
    c += [f"set interfaces lo0 unit 0 family inet address {LO[n]}/32", f"set interfaces lo0 unit 0 family iso address {net(LO[n])}",
          f"set routing-options router-id {LO[n]}", f"set routing-options autonomous-system {ASN}",
          "set protocols isis level 1 disable", "set protocols isis level 2 wide-metrics-only", "set protocols isis interface lo0.0 passive"]
    for lid, ifn, *_ in ifs_of(n):
        if lid in CORE:
            c += [f"set protocols isis interface {ifn}.0 point-to-point", f"set protocols mpls interface {ifn}.0", f"set protocols ldp interface {ifn}.0"]
    c += ["set protocols bgp group RR type internal", f"set protocols bgp group RR local-address {LO[n]}",
          "set protocols bgp group RR family inet unicast", "set protocols bgp group RR family inet-vpn unicast", f"set protocols bgp group RR neighbor {LO['rr1']}"]
    for ifn, v in VRF.get(n, {}).items():
        ceip = next(x[4] for x in ifs_of(n) if x[1] == ifn)
        c += [f"set routing-instances {v} instance-type vrf", f"set routing-instances {v} interface {ifn}.0",
              f"set routing-instances {v} route-distinguisher {ASN}:{RT[v]}{LO[n].split('.')[-1]}",
              f"set routing-instances {v} vrf-target target:{ASN}:{RT[v]}", f"set routing-instances {v} vrf-table-label",
              f"set routing-instances {v} protocols bgp group CE type external", f"set routing-instances {v} protocols bgp group CE peer-as {CE_AS[ceip]}",
              f"set routing-instances {v} protocols bgp group CE neighbor {ceip}"]
    return "\n".join(c) + "\n"

def frr(n, ip, peer, asn, lan):
    a = lan.split("/")[0].rsplit(".", 1)[0] + ".1"
    return (f"frr defaults traditional\nhostname {n}\nservice integrated-vtysh-config\n!\ninterface eth1\n ip address {ip}/30\n!\n"
            f"interface lo\n ip address {a}/{lan.split('/')[1]}\n!\nrouter bgp {asn}\n bgp router-id {a}\n no bgp ebgp-requires-policy\n"
            f" neighbor {peer} remote-as {ASN}\n address-family ipv4 unicast\n  network {lan}\n exit-address-family\n!\n")

UPSTREAM = """! ===== upstream: tránsito AS65100 (Cisco IOL) =====
hostname upstream
interface Loopback0
 ip address 100.100.100.100 255.255.255.255
interface Loopback1
 description Internet simulada
 ip address 198.18.0.1 255.254.0.0
interface Loopback2
 ip address 203.0.113.1 255.255.255.0
interface Ethernet0/1
 description -> pe3 (AS65000)
 ip address 192.0.2.2 255.255.255.252
 no shutdown
router bgp 65100
 bgp router-id 100.100.100.100
 bgp log-neighbor-changes
 neighbor 192.0.2.1 remote-as 65000
 address-family ipv4
  neighbor 192.0.2.1 activate
  network 198.18.0.0 mask 255.254.0.0
  network 203.0.113.0 mask 255.255.255.0
 exit-address-family
end
"""

def main():
    cfg = os.path.join(HERE, "configs"); os.makedirs(cfg, exist_ok=True)
    for f in os.listdir(cfg):
        if f.endswith((".ios", ".set", ".frr.conf")): os.remove(os.path.join(cfg, f))
    for n, k in KINDS.items():
        if n == "upstream": open(os.path.join(cfg, "upstream.ios"), "w").write(UPSTREAM)
        elif k == "cisco-iol": open(os.path.join(cfg, f"{n}.ios"), "w").write(ios(n))
        elif k in ("vjunos-router", "vmx", "crpd"): open(os.path.join(cfg, f"{n}.set"), "w").write(junos(n))
    for n, (ip, peer, asn, lan) in CES.items(): open(os.path.join(cfg, f"{n}.frr.conf"), "w").write(frr(n, ip, peer, asn, lan))

    pos = {"ce-a1": (0, 60), "pe1": (220, 60), "rr1": (470, -120), "p1": (470, 60), "p2": (470, 300), "pe2": (720, 60), "pe3": (720, 300),
           "ce-a2": (980, -40), "ce-b1": (980, 130), "ce-b2": (980, 300), "upstream": (720, 520)}
    grp = {"ce-a1": "CLIENTE-A", "ce-a2": "CLIENTE-A", "ce-b1": "CLIENTE-B", "ce-b2": "CLIENTE-B", "upstream": "TRANSITO"}
    asn = {**{k: ASN for k in KINDS}, "ce-a1": 65501, "ce-a2": 65502, "ce-b1": 65511, "ce-b2": 65512, "upstream": 65100}
    nodes = [{"id": n, "kind": KINDS[n], "asn": asn[n], "group": grp.get(n, "ISP-CORE"), "label": n.upper(),
              "position": {"x": pos[n][0], "y": pos[n][1]}} for n in KINDS]
    links = [{"id": l[0], "a": {"node": l[1], "iface": l[2]}, "b": {"node": l[4], "iface": l[5]}} for l in L]
    lesson = json.load(open(os.path.join(HERE, "lesson.json")))
    checks = [c for s in lesson["steps"][:6] for c in s["check"]]
    lab = {"name": "mpls-l3vpn",
           "description": "11 nodos (~10 GB): núcleo y RR Cisco IOL, PE1 Juniper vJunos, IS-IS, LDP, RR, L3VPN con VRFs solapadas y tránsito con políticas. Clientes en FRR.",
           "nodes": nodes, "links": links, "checks": checks, "lesson": lesson}
    json.dump(lab, open(os.path.join(HERE, "lab.json"), "w"), indent=2, ensure_ascii=False)
    print(f"lab.json + {len(os.listdir(cfg))} ficheros en configs/")

if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# Instala Docker, Containerlab, Node.js, vrnetlab y deja la app como servicio en
# http://<IP>:8080. Lo usan:
#   - la ISO (primer arranque, APP=/opt/junos-isp-lab, usuario lab)
#   - ../install.sh (instalación en un paso sobre un Ubuntu/WSL2 existente)
set -euo pipefail
exec > >(tee -a /var/log/junos-isp-lab-firstboot.log) 2>&1

APP=${APP:-/opt/junos-isp-lab}
LAB_USER=${LAB_USER:-lab}
HAS_SYSTEMD=false; [ -d /run/systemd/system ] && HAS_SYSTEMD=true
STATE=/var/lib/junos-isp-lab
mkdir -p "$STATE"
log() { echo -e "\n==> [junos-isp-lab] $*"; }

log "Esperando red..."
for _ in $(seq 1 60); do curl -fsS --max-time 5 https://download.docker.com >/dev/null 2>&1 && break; sleep 5; done

log "Docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
if $HAS_SYSTEMD; then systemctl enable --now docker; else service docker start || true; fi

log "Containerlab"
if ! command -v containerlab >/dev/null; then bash -c "$(curl -sL https://get.containerlab.dev)"; fi

log "Node.js 22"
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y sshpass build-essential python3 python3-yaml git

log "vrnetlab (para convertir qcow2 de Juniper en imágenes Docker)"
if [ ! -d /opt/vrnetlab ]; then
  git clone --depth 1 https://github.com/srl-labs/vrnetlab /opt/vrnetlab || git clone --depth 1 https://github.com/hellt/vrnetlab /opt/vrnetlab
fi
chown -R "$LAB_USER:$LAB_USER" /opt/vrnetlab

log "Usuario $LAB_USER: grupos docker/kvm y sudo solo para containerlab"
usermod -aG docker "$LAB_USER"
getent group kvm >/dev/null && usermod -aG kvm "$LAB_USER"
CLAB=$(command -v containerlab)
echo "$LAB_USER ALL=(root) NOPASSWD: $CLAB" > /etc/sudoers.d/junos-isp-lab
chmod 440 /etc/sudoers.d/junos-isp-lab

log "MPLS en el kernel (lo usan cRPD y FRR para reenviar con etiquetas)"
printf 'mpls_router\nmpls_iptunnel\n' > /etc/modules-load.d/mpls.conf
modprobe mpls_router 2>/dev/null && modprobe mpls_iptunnel 2>/dev/null || echo "AVISO: no se pudieron cargar los módulos MPLS (en WSL2 el kernel puede no traerlos: el control-plane MPLS funciona, el reenvío con etiquetas en cRPD no)"

log "KSM (comparte memoria entre VMs Junos iguales)"
echo 'w /sys/kernel/mm/ksm/run - - - - 1' > /etc/tmpfiles.d/ksm.conf
echo 1 > /sys/kernel/mm/ksm/run 2>/dev/null || true

log "App: dependencias y compilación"
chown -R "$LAB_USER:$LAB_USER" "$APP"
sudo -u "$LAB_USER" -H bash -c "cd $APP && npm ci && npm run build"

log "Configuración (.env e images.yaml)"
if [ ! -f "$APP/.env" ]; then
  RAM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 - 3072 ))
  WEB_PASSWORD=${WEB_PASSWORD:-}
  [ -f "$APP/appliance/.web-password.b64" ] && WEB_PASSWORD=$(base64 -d "$APP/appliance/.web-password.b64")
  # Sin contraseña solo escuchamos en local (tu PC); con contraseña, en toda la red
  BIND=127.0.0.1; [ -n "$WEB_PASSWORD" ] && BIND=0.0.0.0
  sed -e "s/^DRIVER=.*/DRIVER=mock/" \
      -e "s/^HOST_RAM_BUDGET_MB=.*/HOST_RAM_BUDGET_MB=$RAM_MB/" \
      -e "s/^HOST_VCPU_BUDGET=.*/HOST_VCPU_BUDGET=$(nproc)/" \
      "$APP/.env.example" > "$APP/.env"
  {
    echo "HOST=$BIND"
    echo "WEB_USER=lab"
    echo "WEB_PASSWORD=$WEB_PASSWORD"
  } >> "$APP/.env"
  chown "$LAB_USER:$LAB_USER" "$APP/.env"; chmod 600 "$APP/.env"
  rm -f "$APP/appliance/.web-password.b64"
fi
[ -f "$APP/config/images.yaml" ] || sudo -u "$LAB_USER" cp "$APP/config/images.example.yaml" "$APP/config/images.yaml"

log "Comando lab-import-image"
ln -sf "$APP/appliance/lab-import-image.sh" /usr/local/bin/lab-import-image

log "Servicio web"
if $HAS_SYSTEMD; then
  sed -e "s|^User=.*|User=$LAB_USER|" -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP|" \
    "$APP/appliance/junos-isp-lab.service" > /etc/systemd/system/junos-isp-lab.service
  systemctl daemon-reload
  systemctl enable --now junos-isp-lab.service
else
  echo "Sin systemd (¿WSL2?): arranca la app con:  cd $APP && npm start"
fi

if [ "$APP" != /opt/junos-isp-lab ]; then
  # Instalación sobre un sistema existente: no tocamos el login ni el MOTD
  touch "$STATE/firstboot.done"
  log "Listo. Abre http://localhost:8080  ·  importa imágenes con: sudo lab-import-image <fichero>"
  exit 0
fi

log "Mensaje de bienvenida"
KVM_NOTE="OK"
[ -e /dev/kvm ] || KVM_NOTE="NO HAY /dev/kvm: activa la virtualización anidada en tu hipervisor (vJunos/vMX/vSRX la necesitan; cRPD no)"
cat > /etc/issue <<EOF
Junos ISP Lab  ·  abre en tu navegador:  http://\4:8080   (usuario web: lab)
Importar imágenes Juniper:  sudo lab-import-image <fichero>
KVM: $KVM_NOTE

EOF
cat > /etc/update-motd.d/99-junos-isp-lab <<'EOF'
#!/bin/sh
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "  Junos ISP Lab  ->  http://$IP:8080   (usuario web: lab)"
echo "  Importar imágenes Juniper:  sudo lab-import-image /ruta/a/imagen.qcow2|.tgz"
[ -e /dev/kvm ] || echo "  AVISO: sin /dev/kvm -> activa la virtualización anidada (vJunos/vMX/vSRX la necesitan)"
echo ""
EOF
chmod +x /etc/update-motd.d/99-junos-isp-lab

if [ -d /opt/junos-images ] && [ -n "$(ls -A /opt/junos-images 2>/dev/null)" ]; then
  log "Importando imágenes incluidas en la ISO"
  for f in /opt/junos-images/*; do
    case "$f" in *.yml|*.yaml|*.txt|*.md) continue ;; esac   # plantillas de PNETLab, no son imágenes
    "$APP/appliance/lab-import-image.sh" "$f" || echo "AVISO: no se pudo importar $f"
  done
fi

touch "$STATE/firstboot.done"
log "Listo. Abre http://$(hostname -I | awk '{print $1}'):8080"

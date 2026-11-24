#!/usr/bin/env bash
# =============================================================================
#  Genera una ISO de instalación desatendida "Junos ISP Lab" basada en
#  Ubuntu Server 24.04. Arranca la VM con ella y, sin preguntas, queda:
#  Ubuntu + Docker + Containerlab + vrnetlab + la app en http://<IP>:8080
#
#  Uso (en cualquier Linux con xorriso, curl y openssl):
#    ./build-iso.sh                                  # descarga Ubuntu y genera la ISO
#    ./build-iso.sh --iso ubuntu-24.04.3-live-server-amd64.iso
#    ./build-iso.sh --images /ruta/mis-imagenes-juniper   # (opcional) las mete en la ISO
#
#  Variables opcionales: LAB_PASSWORD (si no, la pide), KEYBOARD=es|latam|us,
#  TIMEZONE=Europe/Madrid, UBUNTU_RELEASE=24.04, OUT=junos-isp-lab.iso
# =============================================================================
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/.." && pwd)
ISO=""; IMAGES=""
OUT=${OUT:-$PWD/junos-isp-lab.iso}
UBUNTU_RELEASE=${UBUNTU_RELEASE:-24.04}
KEYBOARD=${KEYBOARD:-es}
TIMEZONE=${TIMEZONE:-Europe/Madrid}

while [ $# -gt 0 ]; do
  case "$1" in
    --iso) ISO=$2; shift 2 ;;
    --images) IMAGES=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $1"; exit 1 ;;
  esac
done

for t in xorriso curl openssl tar sha256sum; do
  command -v $t >/dev/null || { echo "Falta '$t'. En Debian/Ubuntu: sudo apt install xorriso curl openssl"; exit 1; }
done

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# --- 1. ISO base de Ubuntu Server (descarga + verificación SHA256) ---------
if [ -z "$ISO" ]; then
  BASE=https://releases.ubuntu.com/$UBUNTU_RELEASE
  curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS"
  NAME=$(grep -o 'ubuntu-[0-9.]*-live-server-amd64.iso' "$WORK/SHA256SUMS" | head -1)
  ISO=$PWD/$NAME
  if [ ! -f "$ISO" ]; then echo "==> Descargando $NAME (~3 GB)"; curl -fL --progress-bar "$BASE/$NAME" -o "$ISO"; fi
  echo "==> Verificando SHA256"
  (cd "$(dirname "$ISO")" && grep " \*\?$NAME\$" "$WORK/SHA256SUMS" | sed 's/\*//' | sha256sum -c -)
fi
[ -f "$ISO" ] || { echo "No existe la ISO: $ISO"; exit 1; }

# --- 2. Contraseña del usuario 'lab' (Linux y web) -------------------------
if [ -z "${LAB_PASSWORD:-}" ]; then
  read -rsp "Contraseña para el usuario 'lab' (SSH, consola y web): " LAB_PASSWORD; echo
  read -rsp "Repítela: " P2; echo
  [ "$LAB_PASSWORD" = "$P2" ] || { echo "No coinciden"; exit 1; }
fi
[ ${#LAB_PASSWORD} -ge 6 ] || { echo "Usa al menos 6 caracteres"; exit 1; }
HASH=$(openssl passwd -6 "$LAB_PASSWORD")
WEB_B64=$(printf '%s' "$LAB_PASSWORD" | base64 -w0)

# --- 3. Configuración autoinstall (cloud-init NoCloud) ----------------------
mkdir -p "$WORK/nocloud"
sed -e "s|__PASSWORD_HASH__|$HASH|" -e "s|__WEB_PASSWORD_B64__|$WEB_B64|" \
    -e "s|__KEYBOARD__|$KEYBOARD|" -e "s|__TIMEZONE__|$TIMEZONE|" \
    "$HERE/autoinstall/user-data.tpl" > "$WORK/nocloud/user-data"
touch "$WORK/nocloud/meta-data"

# --- 4. La app (sin node_modules, builds ni secretos) ----------------------
tar -czf "$WORK/junos-isp-lab.tgz" -C "$(dirname "$APP_DIR")" \
  --exclude='node_modules' --exclude='dist' --exclude='data' --exclude='.env' \
  --exclude='config/images.yaml' --exclude='*.iso' --exclude='*.qcow2' \
  "$(basename "$APP_DIR")"
# Dentro de la VM la app vive en /opt/junos-isp-lab
if [ "$(basename "$APP_DIR")" != "junos-isp-lab" ]; then
  mkdir -p "$WORK/re" && tar -xzf "$WORK/junos-isp-lab.tgz" -C "$WORK/re" && mv "$WORK/re/$(basename "$APP_DIR")" "$WORK/re/junos-isp-lab"
  tar -czf "$WORK/junos-isp-lab.tgz" -C "$WORK/re" junos-isp-lab
fi

# --- 5. Menú de arranque: entrada de instalación automática primero --------
xorriso -osirrox on -indev "$ISO" -extract /boot/grub/grub.cfg "$WORK/grub.cfg" 2>/dev/null
chmod u+w "$WORK/grub.cfg"
ENTRY='menuentry "Instalar Junos ISP Lab (BORRA EL DISCO de la VM)" {\n\tset gfxpayload=keep\n\tlinux\t/casper/vmlinuz quiet autoinstall ds=nocloud\;s=/cdrom/nocloud/ ---\n\tinitrd\t/casper/initrd\n}\n'
awk -v entry="$ENTRY" 'BEGIN{done=0} /^set timeout=/{print "set timeout=10"; next} /^menuentry/ && !done {printf entry; done=1} {print}' "$WORK/grub.cfg" > "$WORK/grub.new"
grep -q "Junos ISP Lab" "$WORK/grub.new" || { echo "No pude modificar grub.cfg"; exit 1; }

# --- 6. Montar la nueva ISO (conserva el arranque BIOS + UEFI original) ----
MAPS=(-map "$WORK/nocloud" /nocloud -map "$WORK/grub.new" /boot/grub/grub.cfg -map "$WORK/junos-isp-lab.tgz" /junos-isp-lab.tgz)
if [ -n "$IMAGES" ]; then
  [ -d "$IMAGES" ] || { echo "--images debe ser una carpeta"; exit 1; }
  echo "==> Incluyendo imágenes de $IMAGES (solo para uso propio: respeta las licencias de Juniper)"
  MAPS+=(-map "$IMAGES" /images)
fi
rm -f "$OUT"
xorriso -indev "$ISO" -outdev "$OUT" -compliance iso_9660_level=3 "${MAPS[@]}" -boot_image any replay
echo
echo "==> ISO generada: $OUT"
echo "    Crea una VM (recomendado 8 vCPU, 24-32 GB RAM, 80 GB disco, virtualización anidada ON),"
echo "    arranca con esta ISO y espera: se instala sola, reinicia y la consola mostrará la URL."

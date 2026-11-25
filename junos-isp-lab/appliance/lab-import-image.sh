#!/usr/bin/env bash
# Importa una imagen Juniper a la appliance y la registra en config/images.yaml.
#   sudo lab-import-image /ruta/junos-routing-crpd-docker-24.2R1.14.tgz
#   sudo lab-import-image /ruta/vJunos-router-23.2R1.15.qcow2
#   sudo lab-import-image /ruta/vjunosrouter-24.2R1-S2.5.tgz        (formato PNETLab/LabHub)
#   sudo lab-import-image /opt/unetlab/addons/qemu/vjunosrouter-24.2R1-S2.5   (carpeta de PNETLab)
#   sudo lab-import-image /opt/unetlab/addons/iol/bin/i86bi-linux-l3-adventerprisek9-15.5.2T.bin
#   sudo lab-import-image --version 17.12.01 x86_64_crb_linux-adventerprisek9-ms.iol
# Opcional: --kind crpd|cisco-iol|vjunos-router|vmx|vsrx|cjunosevolved   --version X (si el nombre no la trae)
set -euo pipefail
# La app es la carpeta padre de este script (vale para /opt/junos-isp-lab o un clon en tu $HOME)
APP=${APP:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}
VRNETLAB=${VRNETLAB:-/opt/vrnetlab}
LAB_USER=${LAB_USER:-$(stat -c %U "$APP")}

KIND=""; FORCE_VER=""
while [ $# -gt 1 ]; do
  case "$1" in
    --kind) KIND=$2; shift 2 ;;
    --version) FORCE_VER=$2; shift 2 ;;
    *) break ;;
  esac
done
FILE=${1:?Uso: lab-import-image [--kind KIND] <fichero .qcow2|.tgz|.tar | carpeta de PNETLab>}
[ -e "$FILE" ] || { echo "No existe: $FILE"; exit 1; }
FILE=$(realpath "$FILE")
NAME=$(basename "$FILE" | tr 'A-Z' 'a-z')
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Versión a partir del nombre: vjunosrouter-24.2R1-S2.5.tgz → 24.2R1-S2.5
version_of() { [ -n "$FORCE_VER" ] && { echo "$FORCE_VER"; return; }; basename "$1" | sed -E 's/\.(tgz|tar\.gz|tar|qcow2)$//' | grep -oE '[0-9]+\.[0-9]+[A-Za-z][0-9A-Za-z.-]*' | head -1 || true; }

# ¿Formato PNETLab? (carpeta o .tgz con virtioa.qcow2 / hda.qcow2 dentro)
PNET_DISK_RE='(^|/)(virtio[a-z]|hd[a-z]|sata[a-z])\.qcow2$'
pnet_disk=""
if [ -d "$FILE" ]; then
  pnet_disk=$(find "$FILE" -maxdepth 2 -name '*.qcow2' | grep -E "$PNET_DISK_RE" | sort | head -1 || true)
  [ -n "$pnet_disk" ] || { echo "La carpeta $FILE no contiene virtioa.qcow2/hda.qcow2"; exit 1; }
elif [[ "$NAME" =~ \.(tgz|tar\.gz|tar)$ ]] && [[ "$NAME" != *crpd* ]] && [[ "$NAME" != *cjunos* ]] && [[ "$NAME" != vmx-bundle* ]]; then
  echo "==> Inspeccionando $NAME (puede tardar en ficheros grandes)..."
  inner=$(tar -tf "$FILE" | grep -E "$PNET_DISK_RE" | sort | head -1 || true)
  if [ -n "$inner" ]; then
    echo "==> Formato PNETLab detectado: extrayendo $inner"
    tar -xf "$FILE" -C "$TMP" "$inner"
    pnet_disk="$TMP/$inner"
  fi
fi

if [ -z "$KIND" ]; then
  case "$NAME" in
    *crpd*)                                   KIND=crpd ;;
    *linux-l2*|*l2-*.bin|*ioll2*)             echo "IOL L2 (switch) aún no está en el catálogo: importa el IOL L3"; exit 1 ;;
    *.bin|*.iol|*linux-l3*|*iol*)             KIND=cisco-iol ;;
    *cjunos*|*junosevolved*|*junos-evo*)      KIND=cjunosevolved ;;
    *vjunos-router*|*vjunosrouter*)           KIND=vjunos-router ;;
    *vsrx*)                                   KIND=vsrx ;;
    *vmx*)                                    KIND=vmx ;;
    *) echo "No reconozco el tipo de '$NAME'. Usa --kind crpd|vjunos-router|vmx|vsrx|cjunosevolved"; exit 1 ;;
  esac
fi
echo "==> $FILE  →  kind '$KIND'"

before=$(docker images --format '{{.Repository}}:{{.Tag}}' | sort)
TAG=""
case "$KIND" in
  crpd|cjunosevolved)
    # Contenedores: basta con docker load
    TAG=$(docker load -i "$FILE" | sed -n 's/^Loaded image: //p' | tail -1)
    ;;
  cisco-iol)
    # IOL: vrnetlab cisco/iol espera cisco_iol-<versión>.bin
    DIR=cisco/iol
    [ -d "$VRNETLAB/$DIR" ] || { echo "No encuentro $VRNETLAB/$DIR (¿vrnetlab actualizado?)"; ls "$VRNETLAB/cisco" || true; exit 1; }
    VER=$(version_of "$FILE")
    [ -n "$VER" ] || { echo "El nombre '$NAME' no trae versión: usa --version (ej. --version 17.12.01)"; exit 1; }
    case "$NAME" in i86bi*) echo "AVISO: i86bi-* es IOL antiguo de 32 bits (15.x). Puede necesitar licencia iourc y no estar soportado por vrnetlab; lo recomendado es IOL 17.x (x86_64_crb_linux-*)." ;; esac
    rm -f "$VRNETLAB/$DIR"/cisco_iol-*.bin
    cp "$FILE" "$VRNETLAB/$DIR/cisco_iol-$VER.bin"
    echo "==> $(basename "$FILE") → $DIR/cisco_iol-$VER.bin"
    (cd "$VRNETLAB/$DIR" && make)
    TAG=$(comm -13 <(echo "$before") <(docker images --format '{{.Repository}}:{{.Tag}}' | sort) | grep -v '<none>' | head -1 || true)
    [ -n "$TAG" ] || TAG=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i "cisco_iol" | head -1 || true)
    ;;
  vjunos-router|vmx|vsrx)
    # VMs qcow2: se empaquetan con vrnetlab (QEMU dentro de un contenedor)
    case "$KIND" in
      vjunos-router) DIR=juniper/vjunosrouter ;;
      vmx)           DIR=juniper/vmx ;;
      vsrx)          DIR=juniper/vsrx ;;
    esac
    if [ ! -d "$VRNETLAB/$DIR" ]; then
      echo "No encuentro $VRNETLAB/$DIR. Carpetas Juniper disponibles en vrnetlab:"; ls "$VRNETLAB/juniper" || true
      echo "Copia el fichero a la carpeta correcta y ejecuta 'make' allí, luego vuelve a lanzar con --kind."; exit 1
    fi
    if [ -n "$pnet_disk" ]; then
      # vrnetlab deduce la versión del nombre del qcow2: lo renombramos como el oficial de Juniper
      VER=$(version_of "$FILE")
      [ -n "$VER" ] || { echo "No pude sacar la versión de '$NAME'. Renombra el fichero con la versión (ej. vjunosrouter-24.2R1-S2.5.tgz)"; exit 1; }
      case "$KIND" in
        vjunos-router) TARGET="vJunos-router-$VER.qcow2" ;;
        vsrx)          TARGET="junos-vsrx3-x86-64-$VER.qcow2" ;;
        vmx)           echo "vMX en formato PNETLab no está soportado por vrnetlab: usa el vmx-bundle-*.tgz oficial"; exit 1 ;;
      esac
      echo "==> $(basename "$pnet_disk") → $DIR/$TARGET"
      rm -f "$VRNETLAB/$DIR"/*.qcow2
      cp "$pnet_disk" "$VRNETLAB/$DIR/$TARGET"
    else
      cp "$FILE" "$VRNETLAB/$DIR/"
    fi
    (cd "$VRNETLAB/$DIR" && make)
    TAG=$(comm -13 <(echo "$before") <(docker images --format '{{.Repository}}:{{.Tag}}' | sort) | grep -v '<none>' | head -1 || true)
    # Si la imagen ya existía (misma versión), toma la más reciente de ese tipo
    [ -n "$TAG" ] || TAG=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i "${DIR#juniper/}" | head -1 || true)
    ;;
esac
[ -n "$TAG" ] || { echo "No se pudo determinar el tag de la imagen creada. Revisa 'docker images' y edita $APP/config/images.yaml a mano."; exit 1; }
echo "==> Imagen Docker: $TAG"

# Registra el tag en el catálogo conservando los comentarios del YAML
CFG="$APP/config/images.yaml"
[ -f "$CFG" ] || cp "$APP/config/images.example.yaml" "$CFG"
python3 - "$CFG" "$KIND" "$TAG" <<'PY'
import re, sys
path, kind, tag = sys.argv[1:]
text = open(path).read()
block = re.search(rf"(?ms)^  {re.escape(kind)}:\n.*?(?=^  \S|\Z)", text)
if not block:
    sys.exit(f"El kind '{kind}' no está en {path}")
new = re.sub(r'(?m)^(    image:\s*)".*?"', lambda m: f'{m.group(1)}"{tag}"', block.group(0), count=1)
open(path, "w").write(text[:block.start()] + new + text[block.end():])
print(f"==> {path}: {kind}.image = {tag}")
PY
chown "$LAB_USER:$LAB_USER" "$CFG" 2>/dev/null || true

# Con al menos una imagen real, la app pasa a desplegar con containerlab
sed -i 's/^DRIVER=.*/DRIVER=containerlab/' "$APP/.env"
systemctl restart junos-isp-lab.service 2>/dev/null || true
echo "==> Listo. En la web, el tipo '$KIND' ya despliega routers reales."

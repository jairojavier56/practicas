#!/usr/bin/env bash
# Importa una imagen Juniper a la appliance y la registra en config/images.yaml.
#   sudo lab-import-image /ruta/junos-routing-crpd-docker-24.2R1.14.tgz
#   sudo lab-import-image /ruta/vJunos-router-23.2R1.15.qcow2
# Opcional: forzar el tipo con  --kind crpd|vjunos-router|vmx|vsrx|cjunosevolved
set -euo pipefail
APP=${APP:-/opt/junos-isp-lab}
VRNETLAB=${VRNETLAB:-/opt/vrnetlab}
LAB_USER=${LAB_USER:-lab}

KIND=""
if [ "${1:-}" = "--kind" ]; then KIND=$2; shift 2; fi
FILE=${1:?Uso: lab-import-image [--kind KIND] <fichero .qcow2|.tgz|.tar>}
[ -f "$FILE" ] || { echo "No existe: $FILE"; exit 1; }
NAME=$(basename "$FILE" | tr 'A-Z' 'a-z')

if [ -z "$KIND" ]; then
  case "$NAME" in
    *crpd*)                                   KIND=crpd ;;
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
    cp "$FILE" "$VRNETLAB/$DIR/"
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

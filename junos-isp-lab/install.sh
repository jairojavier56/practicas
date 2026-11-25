#!/usr/bin/env bash
# =============================================================================
#  Junos ISP Lab · instalación en un paso
#  Ubuntu 22.04/24.04 (físico, VM o WSL2 en Windows). Sin ISO.
#
#    git clone -b claude/practical-mendel-82nfq2 https://github.com/jairojavier56/practicas.git
#    cd practicas/junos-isp-lab && sudo ./install.sh
#
#  Instala Docker, Containerlab, Node.js 22 y vrnetlab, compila la app y la deja
#  en http://localhost:8080. Después importa tus imágenes:
#    sudo lab-import-image /ruta/i86bi-linux-l3-....bin      (Cisco IOL)
#    sudo lab-import-image /ruta/junos-routing-crpd-....tgz  (Juniper cRPD)
#  Cisco IOL y cRPD son contenedores: NO necesitan virtualización anidada.
# =============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo -E bash "$0" "$@"
APP=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
LAB_USER=${SUDO_USER:-$(stat -c %U "$APP")}
# El servicio corre como $LAB_USER: no puede vivir dentro de /root (permisos 700)
if [[ "$APP" == /root/* ]] && [ "$LAB_USER" != root ]; then
  echo "ERROR: el proyecto está en $APP y el servicio correrá como '$LAB_USER', que no puede entrar en /root."
  echo "Muévelo a tu carpeta y repite:"
  echo "  sudo mv /root/practicas /home/$LAB_USER/ && sudo chown -R $LAB_USER:$LAB_USER /home/$LAB_USER/practicas"
  echo "  cd /home/$LAB_USER/practicas/junos-isp-lab && sudo ./install.sh"
  exit 1
fi
if [ ! -f "$APP/.env" ] && [ -z "${WEB_PASSWORD:-}" ] && [ -t 0 ]; then
  echo "Contraseña para la web (usuario 'lab')."
  echo "Déjala vacía si solo vas a usarla desde este mismo PC (escuchará solo en localhost)."
  read -rsp "Contraseña: " WEB_PASSWORD; echo
fi
export APP LAB_USER WEB_PASSWORD="${WEB_PASSWORD:-}"
exec bash "$APP/appliance/firstboot.sh"

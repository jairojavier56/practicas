#cloud-config
# Instalación desatendida de Ubuntu Server para la appliance Junos ISP Lab.
# build-iso.sh sustituye los marcadores __...__ al generar la ISO.
autoinstall:
  version: 1
  locale: es_ES.UTF-8
  keyboard:
    layout: __KEYBOARD__
  timezone: __TIMEZONE__
  identity:
    hostname: junos-isp-lab
    username: lab
    realname: Junos ISP Lab
    password: "__PASSWORD_HASH__"
  ssh:
    install-server: true
    allow-pw: true
  storage:
    layout:
      name: lvm
      sizing-policy: all
  packages:
    - curl
    - git
    - sshpass
    - ca-certificates
    - build-essential
    - python3
    - python3-yaml
    - qemu-guest-agent
    - open-vm-tools
  late-commands:
    # La app viaja dentro de la ISO; las dependencias se instalan en el primer arranque
    - tar -xzf /cdrom/junos-isp-lab.tgz -C /target/opt
    - sh -c 'if [ -d /cdrom/images ]; then mkdir -p /target/opt/junos-images && cp -r /cdrom/images/. /target/opt/junos-images/; fi'
    - sh -c 'printf "%s\n" "__WEB_PASSWORD_B64__" > /target/opt/junos-isp-lab/appliance/.web-password.b64 && chmod 600 /target/opt/junos-isp-lab/appliance/.web-password.b64'
    - cp /target/opt/junos-isp-lab/appliance/junos-isp-lab-firstboot.service /target/etc/systemd/system/
    - curtin in-target --target=/target -- systemctl enable junos-isp-lab-firstboot.service
  shutdown: reboot

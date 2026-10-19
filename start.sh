#!/bin/sh

G='\033[1;32m'
W='\033[1;37m'
Y='\033[1;33m'
C='\033[0;36m'
N='\033[0m'

cd "$(dirname "$0")"

# instalação (pula se as dependências já estiverem instaladas)
if [ ! -d node_modules/@systemzero/baileys ]; then
  # sugere o ambiente detectado
  case "$PREFIX" in *com.termux*) PADRAO=1 ;; *) PADRAO=2 ;; esac

  printf "${G}Onde o Open Bot vai rodar?${N}\n"
  printf "${W}1) Termux\n2) VPS / hospedagem (Pterodactyl e outras)${N}\n"
  printf "Escolha [${PADRAO}]: "
  read OP
  [ -z "$OP" ] && OP=$PADRAO

  if [ "$OP" = "1" ]; then
    printf "${C}Instalando no Termux...${N}\n"
    pkg update -y
    command -v ffmpeg >/dev/null 2>&1 || pkg install -y ffmpeg
    command -v git >/dev/null 2>&1 || pkg install -y git
    npm install --no-bin-links --legacy-peer-deps
  else
    printf "${C}Instalando...${N}\n"
    npm install --legacy-peer-deps
    command -v ffmpeg >/dev/null 2>&1 || printf "${Y}ffmpeg não encontrado: figurinhas não vão funcionar. Instale com: apt install ffmpeg${N}\n"
  fi

  [ -d node_modules/@systemzero/baileys ] || { printf "${Y}A instalação falhou. Veja o erro acima.${N}\n"; exit 1; }
fi

# termux: impede o android de pausar o bot
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

while :
do
clear
printf "${W}  ___  ____  _____ _   _  ${G} ____   ___ _____\n"
printf "${W} / _ \\|  _ \\| ____| \\ | | ${G}| __ ) / _ \\_   _|\n"
printf "${W}| | | | |_) |  _| |  \\| | ${G}|  _ \\| | | || |\n"
printf "${W}| |_| |  __/| |___| |\\  | ${G}| |_) | |_| || |\n"
printf "${W} \\___/|_|   |_____|_| \\_| ${G}|____/ \\___/ |_|\n\n"
printf "${G}OPEN BOT${N} - reconexão automática ativada...\n\n"

node connect.js --code

printf "${C}Reiniciando o Open Bot [ ! ]${N}\n"
sleep 2
done

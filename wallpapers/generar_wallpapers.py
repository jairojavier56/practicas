# Genera un wallpaper 2K (2560x1440) por foto.
# modo "recorte": llena toda la pantalla recortando a 16:9 (pos = posición vertical 0..1)
# modo "completa": foto vertical entera sobre fondo desenfocado
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
U="/root/.claude/uploads/8864d6f8-d01a-527c-ba42-53036c05e374/"
OUT="/home/user/practicas/wallpapers/2k/"
W,H=2560,1440
fotos=[("1cd3f0f5","01-atardecer-montana","recorte",0.62),
 ("1c8aee18","02-atardecer-montana-2","completa",0),
 ("b8c944b4","03-playa","recorte",0.56),
 ("bf4fce7d","04-ciudad","completa",0),
 ("86bddf4e","05-esquina","recorte",0.58),
 ("02b56c3e","06-iglesia","recorte",0.53),
 ("38e0a08b","07-area-descanso","recorte",0.55)]
for f,name,modo,pos in fotos:
    im=ImageOps.exif_transpose(Image.open(U+f+"-image.jpg")).convert("RGB")
    iw,ih=im.size
    if modo=="recorte":
        ch=round(iw*9/16); top=round((ih-ch)*pos)
        out=im.crop((0,top,iw,top+ch)).resize((W,H),Image.LANCZOS)
    else:
        out=ImageOps.fit(im,(W,H),Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
        out=ImageEnhance.Brightness(out).enhance(0.6)
        fw=round(iw*H/ih); out.paste(im.resize((fw,H),Image.LANCZOS),((W-fw)//2,0))
    out.save(OUT+name+".jpg",quality=95,subsampling=0)
    print(name,modo)

import subprocess, os
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
S="/tmp/claude-0/-home-user-practicas/8864d6f8-d01a-527c-ba42-53036c05e374/scratchpad/"
D=S+"drive/"; U="/root/.claude/uploads/8864d6f8-d01a-527c-ba42-53036c05e374/"; R=S+"reel/"
W,H=1080,1920; FB="/usr/share/fonts/opentype/inter/Inter-Bold.otf"; FM="/usr/share/fonts/opentype/inter/InterDisplay-Medium.otf"
def txt(t,size,y,font=FB):
    t=t.replace(":","\\:")
    return f"drawtext=fontfile={font}:text='{t}':fontsize={size}:fontcolor=white:x=(w-text_w)/2:y={y}:shadowcolor=black@0.7:shadowx=3:shadowy=3"
def prep(name,flip=False):
    im=ImageOps.exif_transpose(Image.open(U+name+"-image.jpg")).convert("RGB")
    if flip: im=ImageOps.mirror(im)
    if im.width/im.height>1:   # foto horizontal o casi: fondo desenfocado
        bg=ImageOps.fit(im,(W*2,H*2)).filter(ImageFilter.GaussianBlur(60)); bg=ImageEnhance.Brightness(bg).enhance(0.55)
        fg=im.resize((W*2,round(im.height*W*2/im.width)),Image.LANCZOS); bg.paste(fg,(0,(H*2-fg.height)//2)); out=bg
    else: out=ImageOps.fit(im,(W*2,H*2),Image.LANCZOS)
    p=R+name+".png"; out.save(p); return p
segs=[]
def V(f,ss,t,extra=[]): segs.append(("v",D+f,ss,t,extra))
def P(n,t,extra=[],flip=False): segs.append(("p",prep(n,flip),0,t,extra))
P("1302f160",3.2,[txt("GALICIA",170,170),txt("en moto · septiembre 2026",58,370,FM)])
V("VID_20260904_101703.mp4",37,3,[txt("DÍA 1 · 4 SEPT",64,160)])
V("VID_20260904_101703.mp4",64,2.5)
V("VID_20260904_102715.mp4",168,3)
V("VID_20260904_102715.mp4",800,3)
V("VID_20260904_110625.mp4",292,2.5)
V("VID_20260904_101703.mp4",462,2.5,[txt("parada técnica",60,160)])
P("629c1482",2.6,[],flip=True)
V("VID_20260906_075408.mp4",1,3,[txt("DÍA 2 · 6 SEPT",64,160)])
V("VID_20260906_083401.mp4",0,3.3)
V("VID_20260906_083356.mp4",0,2.7)
V("VID_20260906_091626.mp4",137,3)
V("VID_20260906_091626.mp4",412,3)
V("VID_20260906_091626.mp4",966,3)
V("VID_20260906_094715.mp4",536,3)
V("VID_20260906_101412.mp4",428,3)
V("VID_20260906_103331.mp4",158,3,[txt("y llegó la lluvia",60,160)])
V("VID_20260906_103331.mp4",172,2.5)
P("b05f7133",2.5)
P("0612cadb",3.8,[txt("1.331 km",150,260),txt("hasta la próxima",58,440,FM)])
parts=[]
for i,(k,src,ss,t,extra) in enumerate(segs):
    o=R+f"seg{i:02d}.mp4"; n=round(t*30)
    if k=="v":
        vf=["scale=1080:1920:force_original_aspect_ratio=increase","crop=1080:1920","fps=30","eq=contrast=1.06:saturation=1.15"]
        inp=["-ss",str(ss),"-t",str(t),"-i",src]; amap=["-map","0:v","-map","0:a"]
        af=f"volume=0.45,aresample=44100,afade=t=in:d=0.15,afade=t=out:st={t-0.15}:d=0.15"
    else:
        vf=[f"zoompan=z='1+0.06*on/{n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={n}:s=1080x1920:fps=30"]
        inp=["-loop","1","-t",str(t),"-i",src,"-f","lavfi","-t",str(t),"-i","anullsrc=r=44100:cl=stereo"]; amap=["-map","0:v","-map","1:a"]; af="anull"
    if i==0: vf.append("fade=t=in:d=0.6")
    if i==len(segs)-1: vf.append(f"fade=t=out:st={t-0.8}:d=0.8")
    vf+=extra+["format=yuv420p"]
    subprocess.run(["ffmpeg","-v","error","-y",*inp,*amap,"-vf",",".join(vf),"-af",af,"-frames:v",str(n),"-c:v","libx264","-preset","medium","-crf","20","-r","30","-c:a","aac","-b:a","160k","-ac","2","-ar","44100",o],check=True)
    parts.append(o); print("ok",i)
open(R+"list.txt","w").write("".join(f"file '{p}'\n" for p in parts))
subprocess.run(["ffmpeg","-v","error","-y","-f","concat","-safe","0","-i",R+"list.txt","-c:v","libx264","-preset","medium","-crf","23","-c:a","aac","-b:a","160k","-movflags","+faststart","/home/user/practicas/videos/galicia_reel.mp4"],check=True)

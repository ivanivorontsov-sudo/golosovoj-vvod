from PIL import Image, ImageDraw
S=512
im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
d.ellipse((8,8,S-8,S-8),fill=(37,99,235,255))
w=S
# капсула микрофона
d.rounded_rectangle((w*0.39,w*0.18,w*0.61,w*0.58),radius=w*0.11,fill='white')
# дуга
d.arc((w*0.29,w*0.32,w*0.71,w*0.70),start=0,end=180,fill='white',width=int(w*0.055))
d.rectangle((w*0.475,w*0.69,w*0.525,w*0.80),fill='white')
d.rounded_rectangle((w*0.36,w*0.78,w*0.64,w*0.83),radius=w*0.02,fill='white')
for n in (16,32,48,128):
    im.resize((n,n),Image.LANCZOS).save(f'extension/icons/icon{n}.png')
print('icons ok')

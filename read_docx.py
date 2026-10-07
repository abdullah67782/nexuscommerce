import sys
import docx

def read_docx(filename):
    doc = docx.Document(filename)
    return '\n'.join([para.text for para in doc.paragraphs])

filename = sys.argv[1]
with open(filename + ".txt", "w", encoding="utf-8") as f:
    f.write(read_docx(filename))

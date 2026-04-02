import http.server, os
os.chdir('/Users/qa_claudius/Documents/AI/Claude/HAPICS_Page/tetris')
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=5678, bind='127.0.0.1')
